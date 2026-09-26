# opencode-runpod — design spec

Date: 2026-09-26
Status: approved design, pre-implementation
Target: opencode **v2** plugin API (`@opencode/plugin` ^2.0.16, binary v2.0.16+). v1 API is out of scope.

## 1. Goal

An opencode plugin that exposes a `runpod` provider whose models run on **RunPod Serverless** (vLLM worker).
Selecting a `runpod/<model>` in opencode lazily provisions a serverless endpoint for that model, waits for the
first worker to be warm, routes requests to it, scales to zero when idle, and deletes the endpoint when opencode
shuts down. Every provisioning step is cost-visible: the user confirms a quote (GPU, $/h, estimated cold start)
before anything is created, sees state and running spend as toasts and a footer status line, and can inspect or
tear down endpoints with slash commands.

Decisions already made with the user:

| Topic | Decision |
|---|---|
| Model class | ~30B class (user's homelab set, faster) + any HF model id via config |
| Weights | HF pull at cold start, quantized (FP8/AWQ/GPTQ) preferred; no network volumes |
| Teardown | RunPod scale-to-zero via `idleTimeout`; endpoints kept across sessions and re-adopted (zero workers = $0); `deleteOnExit` (default false, user decision 2026-09-26) deletes them at shutdown; `/runpod-down` deletes explicitly |
| Cost guard | Ask before **every provision** (endpoint creation) with a quote; re-warm after idle needs no re-ask |
| Confirm UX | Approach A: server plugin + TUI plugin bridged by RPC (native dialogs, toasts, footer widget) |
| Runtime model config (added 2026-09-26) | (a) GPU pool + idle timeout chosen in the provision dialog, (b) GPU tiers exposed as opencode model variants, (c) `/runpod-add`, `/runpod-set`, `/runpod-remove` commands; all persisted in plugin storage (§5.7) |

## 2. Facts the design relies on (verified 2026-09-26)

RunPod:
- REST v1 is deprecated (retired 2026-11-15). Use REST **v2**: `https://api.runpod.io/v2`, `Authorization: Bearer <key>`.
  Endpoints: `GET/POST /v2/serverless`, `GET/PATCH/DELETE /v2/serverless/{id}`, `GET /v2/serverless/{id}/workers`,
  `GET /v2/serverless/{id}/workers/{workerId}/logs`, `GET /v2/catalog/gpus` (has `pool` and `price.serverless` $/h),
  `GET /v2/billing/serverless?endpointId=`. Errors are RFC 9457 problem objects.
- Create body (v2): `name, type:"QUEUE", scaling:{type:"QUEUE_DELAY", queueDelay}, gpu:{pools:[poolID], count, minCudaVersion},
  image, env, disk, workers:{min,max,idleTimeout 1..3600}, timeout (ms), flashboot:"OFF"|"FLASHBOOT", dataCenterIds, networkVolumes`.
  Unknown fields are rejected (`unevaluatedProperties:false`).
- Runtime API per endpoint: `https://api.runpod.ai/v2/{id}/health` → `{jobs:{…}, workers:{idle,initializing,ready,running,throttled}}`;
  OpenAI-compatible base URL `https://api.runpod.ai/v2/{id}/openai/v1` (chat/completions, models; streaming + tool calls).
- Billing: billed while a worker runs (model load into GPU, execution, and the idleTimeout window). Zero workers = $0.
  DELETE stops billing immediately. `workers.min=0` means no worker boots until a request arrives.
- vLLM worker image `runpod/worker-v1-vllm:v2.27.2` (vLLM 0.28). Env: `MODEL_NAME`, `MAX_MODEL_LEN`, `QUANTIZATION`,
  `OPENAI_SERVED_MODEL_NAME_OVERRIDE`, `ENABLE_AUTO_TOOL_CHOICE`, `TOOL_CALL_PARSER`, `REASONING_PARSER`, `HF_TOKEN`,
  `GPU_MEMORY_UTILIZATION`, any `vllm serve` flag upper-cased.
- Serverless flex $/h (pricing page, 2026-09-26): AMPERE_16 0.58 · AMPERE_24 0.69 · ADA_24 1.10 · ADA_32_PRO 1.58 ·
  AMPERE_48 1.22 · ADA_48_PRO 1.75 · AMPERE_80 2.72 · ADA_80_PRO 4.79 · BLACKWELL_96 3.49 · HOPPER_141 5.93. Used only as
  fallback when the catalog call fails.
- Cold start: worker marked unhealthy after 7 min; 30B FP8 from HF ≈ 2–5 min.

opencode v2 plugin API (from `@opencode/plugin@2.0.16` types and docs):
- `Plugin.define({ id, setup(ctx) => cleanup })`. `ctx.options` = `plugins:[{package, options}]` object.
- `ctx.provider.transform(editor => editor.add({ info: Provider.Info, models: Model.Info[] }))`, `ctx.provider.reload()`.
  Provider `package: "@opencode/ai/providers/openai-compatible"`, `settings: { baseURL, apiKey, timeout, chunkTimeout }`.
- `ctx.session.hook("model.request", cb, { providerID })` fires before every model call (kinds primary/compaction/title/generate),
  is awaited, `event.baseURL` and `event.headers` are mutable, `event.model` is `Model.Ref {id, providerID}`.
- `ctx.command.transform(editor => editor.add({ name, description, execute({sessionID, prompt, delivery}) }))`.
- `ctx.session.synthetic({ sessionID, text })` posts a synthetic message (semantics to verify, see §9).
- `ctx.rpc.register(Rpc.define({ id, methods, events }), handlers)` → `{ dispose, events.emit }`;
  TUI: `context.client.rpc(def)` → typed methods + `events.on(name, handler)`.
- `ctx.storage.get/set/remove/scan` durable plugin-scoped JSON. `ctx.event.subscribe()` for core events (`session.idle`, `config.updated`, …).
- TUI entry (`@opencode/plugin/tui`): `Plugin.define({ id, setup(context) })` with `context.ui.dialog.confirm`, `context.ui.toast.show`,
  `context.ui.slot({ append: "prompt.footer.status", render })` (opentui/solid JSX: `<box>`, `<text>`, `<span>`), `context.keymap.layer`,
  `context.storage.memory/store`, `context.client`.
- Entry resolution (`Host.resolve`): npm package → exports `"."` (server), `"./tui"`, `"./rpc"`; local directory → `index`, `tui`, `rpc`
  files at the directory root. opencode runs TS directly (docs publish `./src/index.ts`).

## 3. Architecture: hexagonal (ports & adapters) and package layout

The core (domain + application) has no knowledge of RunPod, vLLM, Hugging Face or opencode. It depends only on
**ports** (TypeScript interfaces). Adapters implement the ports on the outside; the opencode plugin file is the
composition root that wires them. An architecture test enforces the dependency rule.

```
runpod-opencode/                 npm: opencode-runpod (ESM, TypeScript, no build step)
├─ package.json                  exports ".": ./index.ts, "./tui": ./tui.ts, "./rpc": ./rpc.ts
├─ index.ts  tui.ts  rpc.ts      root re-exports (a local directory path loads via Host.resolve too)
├─ src/core/domain/              pure: model.ts (ModelConfig, Settings, ModelOverrides, applyOverrides, deriveModelID, idleTimeoutFor),
│                                endpoint.ts (Phase, WorkerRecipe, EndpointSpec, EndpointRecord, specHash, endpointName), quote.ts (PoolRate,
│                                Quote, buildQuote, estimateColdStartSec, idleWindowUsd), provision.ts (GpuOption, ProvisionProposal,
│                                ProvisionDecision, buildProposal, gpuVariantsFor), spend-meter.ts, events.ts (StateEvent, ModelStatus, StatusReport)
├─ src/core/ports/               driven: compute-provider.ts (ComputeProviderPort, ComputeError), price-catalog.ts, worker-recipe.ts,
│                                weights-info.ts, state-store.ts, clock.ts, confirmation.ts, notifier.ts, logger.ts, catalog-publisher.ts
│                                driving: driving.ts (ModelRoutingPort, OperationsPort, LifecyclePort)
├─ src/core/application/         endpoint-service.ts — EndpointService: the lifecycle state machine, implements the driving ports
├─ src/adapters/driven/runpod/   http.ts (REST v2 client), compute-provider.ts (ComputeProviderPort), pools.ts (pool table),
│                                price-catalog.ts (PriceCatalogPort: live catalog + static fallback)
├─ src/adapters/driven/vllm/     presets.ts (model families → parsers), recipe.ts (WorkerRecipePort → image/env/disk)
├─ src/adapters/driven/huggingface/ weights-info.ts (WeightsInfoPort)
├─ src/adapters/driven/opencode/ state-store.ts (ctx.storage), notifier.ts (RPC events), confirmation.ts (ConfirmBroker + RPC),
│                                catalog-publisher.ts (holds the published model list, triggers provider.reload)
├─ src/adapters/driven/system/   clock.ts, logger.ts
├─ src/adapters/driving/rpc/     contract.ts (zod DTOs typed against domain types, RunpodRpc), format.ts (text for UIs)
├─ src/adapters/driving/opencode/ config.ts (options → Settings + secrets), provider-catalog.ts (Provider.Info/Model.Info),
│                                commands.ts (/runpod-*), plugin.ts (composition root: hook, RPC methods, lifecycle)
├─ src/adapters/driving/tui/     plugin.tsx (dialogs, toasts, footer slots), toasts.ts (pure toast decisions), choose.ts (provision dialog loop)
├─ test/fakes/                   one fake per driven port + fixtures
├─ test/*.test.ts                unit tests; architecture.test.ts enforces the dependency rule
├─ scripts/smoke.ts              opt-in real-API smoke test (needs RUNPOD_API_KEY, spends < $0.10)
├─ examples/opencode.jsonc       example plugin config incl. the user's model set
└─ docs/superpowers/specs/…      this spec
```

Dependency rule (checked by `test/architecture.test.ts`):
- `src/core/**` imports only `src/core/**` and `node:*` builtins.
- `src/adapters/driven/<name>/**` imports `src/core/**`, its own folder, `node:*` and npm packages; never `src/adapters/driving/**` or another driven adapter.
- `src/adapters/driving/**` imports `src/core/**`, `src/adapters/driving/**`, `node:*` and npm packages; only the composition root `src/adapters/driving/opencode/plugin.ts` may import `src/adapters/driven/**`.

Ports (signatures are the contract between tasks):

```ts
interface ComputeProviderPort {                     // RunPod serverless today; any GPU provider tomorrow
  list(): Promise<RemoteEndpoint[]>                 // { id, name, hash: string | null } (hash read from the env marker)
  create(spec: EndpointSpec): Promise<{ id: string }>
  scaleToZero(id: string): Promise<void>
  delete(id: string): Promise<void>                 // 404 is success
  health(id: string): Promise<HealthSnapshot>       // { initializing, running, idle, throttled }
  warmup(id: string, modelID: string, signal: AbortSignal): Promise<void>   // throws ComputeError { kind: "transient" | "fatal" }
  diagnostics(id: string): Promise<string | null>   // unhealthy worker log tail
  setIdleTimeout(id: string, seconds: number): Promise<void>   // PATCH workers.idleTimeout on a live endpoint
  billedUsd(id: string): Promise<number | null>
  inferenceBaseURL(id: string): string
}
interface PriceCatalogPort { rate(pool: string): Promise<PoolRate>; knownPools(): readonly string[] }   // PoolRate { ratePerHour, source, vramGb, label }
interface WorkerRecipePort { recipe(model: ModelConfig, settings: Settings, weightsGb: number | null): WorkerRecipe }  // { image, env, secretEnv, diskGb }
interface WeightsInfoPort { weightsGb(model: ModelConfig): Promise<number | null> }
interface StateStorePort { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void>; remove(key: string): Promise<void>; keys(prefix: string): Promise<string[]> }
interface ClockPort { now(): number; sleep(ms: number): Promise<void>; setTimer(fn: () => void, ms: number): unknown; clearTimer(id: unknown): void }
interface ConfirmationPort { ask(proposal: ProvisionProposal): Promise<ProvisionDecision> }   // proposal = quote + priced GPU options + idle choices; decision = { accepted: false } | { accepted: true; overrides: { gpu?, idleTimeout? } }
interface CatalogPublisherPort { publish(models: readonly PublishedModel[]): Promise<void> }   // PublishedModel { config: ModelConfig; variants: string[] } → opencode provider reload
interface NotifierPort { state(event: StateEvent): void; notice(level: "info" | "warning" | "error", message: string): void }
interface LoggerPort { info(message: string, extra?: Record<string, unknown>): void; warn(message: string, extra?: Record<string, unknown>): void }
interface ModelRoutingPort { ensureReady(modelID: string, opts?: { skipConfirm?: boolean; gpu?: string }): Promise<string> }  // gpu = selected variant (pool id); returns inference base URL
interface OperationsPort {
  status(): Promise<StatusReport>; up(modelID: string): Promise<string>; down(modelID?: string): Promise<string[]>
  add(input: { hf: string; gpu?: string; overrides?: ModelOverrides }): Promise<ModelConfig>; set(modelID: string, overrides: ModelOverrides): Promise<ModelConfig>
  remove(modelID: string): Promise<"removed" | "reset">; models(): readonly ModelConfig[]
}
interface LifecyclePort { start(): Promise<void>; stop(budgetMs?: number): Promise<void> }
```

Secrets (RunPod API key, HF token) live only in adapters constructed by the composition root; `Settings` carries none.
`specHash` covers `{ image, env (non-secret), gpu: { pool, count, minCudaVersion } }` and is written to the endpoint env as
`OPENCODE_RUNPOD_HASH` by the RunPod adapter, so reconcile can compare configurations without secrets.

Dependencies: `@opencode/plugin` (^2.0.16), `zod` (options + RPC DTOs). Dev only: `typescript`, `@opentui/solid`, `@opentui/core`,
`solid-js`, `@opencode/theme` (types for the TUI adapter; declared as peerDependencies because the host provides them at runtime).
RunPod is called with plain `fetch`; no RunPod SDK.

Dev loop: `.opencode/opencode.jsonc` in this repo loads `../` as the plugin with a tiny test model; the user's global config
loads the absolute repo path with the real model set. `opencode service restart` after edits that are not picked up by the watcher.

## 4. Configuration (`plugins[].options`)

```jsonc
{
  "apiKey": "{env:RUNPOD_API_KEY}",        // optional; falls back to process.env.RUNPOD_API_KEY
  "hfToken": "{env:HF_TOKEN}",             // optional, gated repos
  "confirm": true,                          // ask before creating an endpoint (default true)
  "confirmTimeoutSec": 120,                 // no answer → treat as declined
  "idleTimeout": 120,                       // RunPod worker idle window, seconds (1..3600)
  "workersMax": 1,                          // parallel workers cap (more = more $)
  "executionTimeoutSec": 600,               // per-request cap on RunPod
  "coldStartTimeoutSec": 600,               // give up warm-up after this
  "deleteOnExit": false,                    // delete owned endpoints when opencode shuts down; default false — a zero-worker endpoint costs $0 and is re-adopted next start
  "adoptExisting": true,                    // reuse a matching oc-runpod-* endpoint found at startup
  "maxHourlyRate": 3.0,                     // refuse provisioning above this $/h (optional)
  "dataCenterIds": [],                      // optional pinning, e.g. ["EU-RO-1"]
  "minCudaVersion": "12.8",
  "workerImage": "runpod/worker-v1-vllm:v2.27.2",
  "flashboot": true,
  "models": {
    "qwen3-coder-30b-a3b": {                // opencode model id → runpod/qwen3-coder-30b-a3b
      "name": "Qwen3 Coder 30B A3B (RunPod)",
      "hf": "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8",
      "gpu": "AMPERE_48",                   // RunPod serverless pool id
      "gpuCount": 1,
      "context": 65536, "output": 8192,
      "tools": true,
      "family": "qwen3-coder",              // preset: toolParser qwen3_xml; optional if hf id matches a preset
      "toolParser": "qwen3_xml",            // overrides preset
      "reasoningParser": null,
      "quantization": "fp8",                // vLLM QUANTIZATION or null
      "weightsGb": null,                    // override HF size lookup
      "idleTimeout": null,                  // per-model override of the global idleTimeout (seconds)
      "env": { "GPU_MEMORY_UTILIZATION": "0.92" }
    }
  }
}
```

Validation is fail-fast at `setup`: a bad option throws with a message naming the key. Unknown keys are rejected.
Presets (`family`): `qwen3` (hermes, reasoning qwen3), `qwen3-coder` (qwen3_xml), `glm-4.7` (glm47/glm47), `gpt-oss` (openai),
`devstral`/`mistral` (mistral), `llama3` (llama3_json), `deepseek-v3` (deepseek_v3/deepseek_r1). A family is inferred from the
HF id when omitted; explicit `toolParser`/`reasoningParser` win.

`{env:…}` / `{file:…}` substitution inside plugin options is unverified; the plugin therefore also accepts raw values and
falls back to `RUNPOD_API_KEY` / `HF_TOKEN` env vars. Secrets never go into logs, toasts, storage, or RPC events.

## 5. Core behaviour (EndpointService) and the opencode driving adapter

### 5.1 Provider registration
`ctx.provider.transform` adds provider `runpod` ("RunPod Serverless"), `package "@opencode/ai/providers/openai-compatible"`,
`settings: { baseURL: "https://api.runpod.ai/v2/pending/openai/v1", apiKey, provider: "runpod", timeout: 600000, chunkTimeout: 600000 }`,
`activation: "enabled"`. One `Model.Info` per configured model: `modelID`, `name`, `capabilities: { tools, input:["text"], output:["text"] }`,
`limit: { context, output }`, `cost` zero (GPU time is not per-token; real $ is tracked by the plugin). If no API key is
available the provider is still registered so the models are visible; using one throws an actionable error.

### 5.2 EndpointService (application core; state machine, one per model)
```
cold ──ensureReady──▶ confirming ──yes──▶ creating ──▶ warming ──▶ ready
  ▲                      │no                                 │            │ idleTimeout elapsed on RunPod (workers 0)
  │                      └─▶ declined (throw)                │            ▼
  └───────────── deleting ◀─── down / exit ◀─────────────────┴──────── idle  ──next request──▶ warming (no confirm)
```
- `ensureReady(modelID)` → inference base URL. Concurrent callers share one in-flight promise per model. All I/O goes through ports: `ComputeProviderPort` (create/warm/health/delete), `PriceCatalogPort` + `WeightsInfoPort` (quote), `WorkerRecipePort` (image/env/disk), `StateStorePort` (records), `ClockPort` (timers), `ConfirmationPort`, `NotifierPort`, `LoggerPort`.
- **confirming**: build quote (§5.4) and a **proposal** (the quote plus every known GPU pool priced for this model with a fits flag, and
  idle-timeout choices 30/60/120/300/600/1800 s); if `confirm` is false or the call comes from `/runpod-up`, skip. Otherwise emit RPC event
  `confirm.requested {requestID, proposal}` and await RPC method `confirm {requestID, accepted, overrides?}` up to `confirmTimeoutSec`;
  timeout or `accepted:false` → throw `RunPod: provisioning of <model> declined/unanswered. Run /runpod-up <model> or set options.confirm=false.`
  Accepted `overrides` (gpu, idleTimeout) are applied through `set()` (§5.7), the quote is rebuilt and re-checked against `maxHourlyRate`, then creation proceeds.
- **creating**: `compute.create(spec)`; the RunPod adapter maps `EndpointSpec` to `POST /v2/serverless`: name `oc-runpod-<modelID>`, `type QUEUE`, `gpu {pools:[gpu], count, minCudaVersion}`,
  `image`, `env` = `{ MODEL_NAME: hf, OPENAI_SERVED_MODEL_NAME_OVERRIDE: modelID, MAX_MODEL_LEN: context, ENABLE_AUTO_TOOL_CHOICE, TOOL_CALL_PARSER,
  REASONING_PARSER?, QUANTIZATION?, HF_TOKEN?, OPENCODE_RUNPOD: "1", OPENCODE_RUNPOD_HASH: envHash, ...userEnv }`, `disk = ceil(weightsGb*1.15)+10`,
  `workers { min 0, max workersMax, idleTimeout }`, `scaling { QUEUE_DELAY, queueDelay 1 }`, `timeout executionTimeoutSec*1000`,
  `flashboot FLASHBOOT|OFF`, `dataCenterIds`. Persist `endpoints/<modelID>` in storage.
- **warming**: `workers.min=0` boots nothing by itself, so send `POST {base}/openai/v1/chat/completions {model: modelID, messages:[{role:"user",content:"ping"}], max_tokens: 1}`
  with a `coldStartTimeoutSec` abort. In parallel poll `GET /v2/{id}/health` every 3 s and emit `state` events
  (`initializing`/`running` counts, elapsed seconds). Ready when the warm-up response arrives. Failure modes: timeout →
  throw (endpoint kept, state `cold`); worker `UNHEALTHY` (from `/v2/serverless/{id}/workers`) → fetch last 40 log lines of that worker
  and include them in the error.
- **ready**: hook sets `event.baseURL = https://api.runpod.ai/v2/{id}/openai/v1`. Each request updates `lastRequestAt`.
  If `now - lastRequestAt > idleTimeout + 15 s` the worker has most likely scaled to zero: run warm-up again (toast "Cold start…", no confirm).
- **deleting** (`/runpod-down`, exit): `PATCH workers {min 0, max 0}` then `DELETE`; clear storage; emit final `state {phase:"deleted", spendUsd}`.
- `start()` reconcile: `GET /v2/serverless`, take names `oc-runpod-*`. Name matches a configured model and `OPENCODE_RUNPOD_HASH` equals the
  current spec hash → adopt (state `idle`) when `adoptExisting`. Name matches a configured model but the hash differs, or a second endpoint
  exists for the same model → stale: deleted (it would be replaced on next use anyway; $0 while idle). Name matches no configured model
  (removed from config, or another opencode location's model) → never deleted automatically; reported as an orphan in `/runpod-status`.
- `stop(budgetMs = 10000)` (plugin cleanup / opencode shutdown): when `deleteOnExit` (default **false**), delete all owned endpoints within the
  budget, best effort, errors logged. With the default, endpoints survive shutdown at $0 and are re-adopted by the next `start()`.

### 5.3 model.request hook (driving adapter)
`ctx.session.hook("model.request", async (e) => { e.baseURL = await routing.ensureReady(e.model.id) }, { providerID: "runpod" })` where `routing: ModelRoutingPort` is the `EndpointService`.
Errors thrown here surface in the session as the request error. No changes to headers (apiKey comes from provider settings).

### 5.4 Pricing (`core/domain/quote.ts`, pure; rates via `PriceCatalogPort`)
- `quote(model)`: pool → `$/h` via `PriceCatalogPort.rate(pool)` (RunPod adapter: `GET /v2/catalog/gpus` (`price.serverless`, cached 10 min) with static table fallback; `× gpuCount`;
  `weightsGb` from config or HF lookup (`GET https://huggingface.co/api/models/{hf}?blobs=true`, sum of `*.safetensors` sizes, cached in storage);
  `estColdStartSec = 45 + weightsGb × 3.5` (heuristic, shown as "≈"); `idleWindowUsd = rate × idleTimeout / 3600`; `fits`: warn when
  `weightsGb > poolVram × 0.85`. Refuse when `rate > maxHourlyRate`.
- `spend(model)`: local estimate `rate × (warmingSec + readySecWithWorkers)/3600` where "with workers" is measured between warm-up start and the
  last request + idleTimeout; plus actual from `GET /v2/billing/serverless?endpointId=` when the call succeeds. Status shows both.

### 5.5 Commands (opencode driving adapter, work in any client; call `OperationsPort`)
- `/runpod-status` — per configured model: state, endpoint id, GPU, $/h, warm/cold, session spend (est. + billed), orphans found.
- `/runpod-up <model>` — provision without dialog (explicit command = consent), then warm up.
- `/runpod-down [model|all]` — scale to zero and delete.
- `/runpod-add <hf-repo> [gpu-pool] [key=value …]` — add a model at runtime (§5.7); without a pool the cheapest pool whose VRAM × 0.85 ≥ weights is chosen.
- `/runpod-set <model> key=value [key=value …]` — change `gpu`, `gpuCount`, `context`, `output`, `idleTimeout`, `quantization`, `tools`, `family`, `toolParser`, `reasoningParser`, `weightsGb`, `name`, `hf` at runtime (`null` clears a nullable key).
- `/runpod-remove <model>` — runtime model: deleted with its endpoint; static model: overrides cleared back to `opencode.json`.
Replies are posted with `ctx.session.synthetic` if verified not to trigger a model turn (§9); otherwise via RPC `notice` event (TUI toast) only.

### 5.6 RPC contract (`adapters/driving/rpc/contract.ts`, zod DTOs typed against the domain types)
- methods: `status() → StatusReport`, `up({modelID})`, `down({modelID?})`, `confirm({requestID, accepted, overrides?: {gpu?, idleTimeout?}})`.
- events: `confirm.requested {requestID, proposal: {quote, gpuOptions:[{pool, label, ratePerHour, rateSource, vramGb, fits, estColdStartSec, current}], idleTimeoutChoices}}`,
  `state {modelID, phase, detail, elapsedSec, spendUsd, ratePerHour, gpu, gpuLabel}`, `notice {level, message}`.

### 5.7 Runtime model configuration
Three entry points, one mechanism. The service keeps the **effective** config per model id: the static `opencode.json` entry
merged with persisted `ModelOverrides` (`overrides/<id>` in plugin storage) or, for models added at runtime, a full `ModelConfig`
(`models/<id>`). `start()` loads both before reconciling. After every change the service publishes the effective list plus GPU
**variants** through `CatalogPublisherPort`; the opencode adapter calls `provider.reload()`, so `/models` updates live.
- **Dialog** (a): the TUI runs a `dialog.select` loop — *Provision on <pool> — $/h* · *Change GPU…* (every pool, priced, fits flag) ·
  *Change idle timeout (N s)…* · *Cancel*. Accepted `overrides` are persisted like any `set()`.
- **Variants** (b): each published model lists as variants the pool ids whose VRAM ≥ the effective pool's VRAM, sorted by price.
  Selecting a variant in `/models` makes `model.request` carry `model.variant`; the hook calls `ensureReady(id, { gpu: variant })`.
  A variant different from the effective pool is applied as `set(id, { gpu })` before provisioning.
- **Commands** (c): see §5.5. `set()` rules: unknown pool or out-of-range value → rejected with the known pools / bounds; if the model
  has an endpoint and the change alters the spec hash (hf, gpu, gpuCount, context, tools, parsers, quantization, env) the endpoint is
  deleted (notice: re-provision on next use, with confirm); if only `idleTimeout` changed the live endpoint is patched via
  `setIdleTimeout`. `add()` derives the id from the repo name (`Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8` → `qwen3-coder-30b-a3b-instruct-fp8`),
  uses the config-schema defaults, and rejects duplicates. `remove()` deletes a runtime model (and its endpoint) or resets a static
  model's overrides.

## 6. TUI plugin (`tui.ts`)
- `client.rpc(RunpodRpc).events.on("confirm.requested")` → `chooseProvision(ui.dialog, proposal)`: a `dialog.select` loop
  (*Provision on <pool> — $/h* with the quote as description · *Change GPU…* → select over `proposal.gpuOptions` · *Change idle timeout…* →
  select over `idleTimeoutChoices` priced per idle window · *Cancel*) → `rpc.confirm({ requestID, accepted, overrides })`.
  Multiple TUIs: first reply wins; server ignores later ones.
- `events.on("state")` → `ui.toast.show` on phase transitions: creating ("Provisioning A6000 48GB · $1.22/h"), warming progress every 30 s
  ("Cold start 90s · initializing 1"), ready ("Ready in 142s"), idle ("Scaled to zero · ≈$0.11 this session"), deleted ("Deleted · ≈$0.31"), errors.
- Footer: `ui.slot({ append: "prompt.footer.status", render })` showing the active runpod model only:
  `runpod: <gpu> <warm|cold|warming 87s> · $<rate>/h · ≈$<spend>`; hidden when no runpod model has been used this run.
  State lives in `context.storage.memory("runpod", { initial })` updated from `state` events; on TUI start it calls `rpc.status()` once.
- Palette command "RunPod: status" (`keymap.layer` command, `palette: true`, no slash name to avoid clashing with server commands) → `rpc.status()` → `ui.dialog.alert`.

## 7. Error handling summary
| Situation | Behaviour |
|---|---|
| Missing API key | provider + models visible; `model.request` throws "RunPod API key missing (options.apiKey or RUNPOD_API_KEY)" |
| RunPod 4xx (RFC 9457) | throw `RunPod <status> <title>: <detail>`; 401/403 add key hint |
| 429 / 5xx / network | retry ×3 with 1s·2ⁿ backoff, then throw |
| Confirm declined / timeout | throw actionable message; state back to `cold`, nothing created |
| Cold start timeout / unhealthy worker | throw with elapsed + worker log tail; endpoint kept for `/runpod-down` or retry |
| `maxHourlyRate` exceeded / weights don't fit | refuse before dialog with the numbers |
| Cleanup failure at exit (`deleteOnExit` on) | logged; never blocks shutdown; next startup reconcile adopts or replaces the leftovers |
| Two plugin instances (global + project config) | both adopt by name; last one out deletes; documented caveat |

## 8. Testing
- Unit (`node --test`, TS): domain (specHash, quote math, SpendMeter, events); `EndpointService` against fakes for every port (confirm accept/decline/timeout, blocked quotes, in-flight dedupe, warm-up retry/timeout/diagnostics, idle re-warm, reconcile adopt/stale/orphan, teardown order, status); each driven adapter against a fake `fetch` (RunPod HTTP mapping, RFC 9457 errors, retries, pagination; vLLM recipe env/parsers/disk; HF sizes); driving adapters (config resolution incl. secret placeholders and `key=value` override parsing, provider/model builders incl. variants, command parsing/replies for status/up/down/add/set/remove, RPC DTO round-trips, toast decisions, the `chooseProvision` dialog loop against a scripted dialog); runtime config in the service (overrides persisted, hash-changing edits tear down, idle-only edits patch, `add` picks the cheapest fitting pool, `remove` vs reset, variants published); `architecture.test.ts` enforcing the dependency rule.
- Smoke (opt-in, `RUNPOD_API_KEY`): `scripts/smoke.ts` creates `Qwen/Qwen3-0.6B` on `AMPERE_16`, warms, sends one request, deletes; asserts spend < $0.10.
- Manual e2e: load via local path in the user's global config; `/models` shows `runpod/*`; pick one, prompt → dialog → toasts → answer; `/runpod-status`; quit → endpoint gone in RunPod console.

## 9. Open verification items (first implementation tasks)
1. `ctx.session.synthetic` — does it trigger a model turn? Decide command reply channel accordingly.
2. Local directory plugin loading: does `Host.resolve(directory)` pick up `index.ts`/`tui.ts`/`rpc.ts` at the repo root? Else use `.opencode/plugins/` symlink.
3. `{env:}` substitution in plugin options.
4. Exact `Provider.Info` / `Model.Info` required fields via `Provider.Info.empty(id)` + tsc.

## 10. Out of scope (v1)
Network volumes and pod (non-serverless) instances; daily/weekly budget caps; load-balancer endpoints;
SGLang worker env mapping (image is configurable but env keys are vLLM's); v1 plugin API; per-token cost accounting in opencode's session $.
