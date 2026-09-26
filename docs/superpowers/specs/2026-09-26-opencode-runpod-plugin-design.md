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
| Teardown | RunPod scale-to-zero via `idleTimeout`; endpoint deleted on opencode exit; re-created on next use |
| Cost guard | Ask before **every provision** (endpoint creation) with a quote; re-warm after idle needs no re-ask |
| Confirm UX | Approach A: server plugin + TUI plugin bridged by RPC (native confirm dialog, toasts, footer widget) |

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

## 3. Package layout

```
runpod-opencode/                 npm: opencode-runpod (ESM, TypeScript, no build step required)
├─ package.json                  exports: ".": ./index.ts, "./tui": ./tui.ts, "./rpc": ./rpc.ts
├─ index.ts  tui.ts  rpc.ts      root re-exports so a local directory path also loads (Host.resolve)
├─ src/
│  ├─ server/plugin.ts           Plugin.define — wires everything below
│  ├─ server/config.ts           zod schema for options, defaults, presets merge
│  ├─ server/presets.ts          model-family → parser/quant defaults; GPU pool table (VRAM, fallback $/h)
│  ├─ server/runpod/client.ts    REST v2 + runtime API thin client (fetch), RFC 9457 errors, backoff
│  ├─ server/runpod/body.ts      pure: model config → CreateEndpointRequest (env, disk, workers, …) + envHash
│  ├─ server/hf.ts               pure-ish: HF repo → weights size (GB) via huggingface.co/api (optional, cached)
│  ├─ server/pricing.ts          quote (pool, $/h, cold-start estimate, idle-window $), spend estimate
│  ├─ server/manager.ts          per-model endpoint state machine, ensureReady(), warm-up, reconcile, teardown
│  ├─ server/provider.ts         Provider.Info / Model.Info builders for the `runpod` provider
│  ├─ server/commands.ts         /runpod-status /runpod-up /runpod-down
│  ├─ shared/rpc.ts              Rpc.define contract (methods + events) — shared by server and TUI
│  └─ tui/plugin.ts              confirm dialog, toasts, footer status slot, palette command
├─ test/                         node:test unit tests (Node ≥ 22 runs .ts directly)
├─ scripts/smoke.ts              opt-in real-API smoke test (needs RUNPOD_API_KEY, spends < $0.10)
├─ examples/opencode.jsonc       example plugin config incl. the user's model set
└─ docs/superpowers/specs/…      this spec
```

Dependencies: `@opencode/plugin` (peer ^2.0.16 + dev), `zod` (options + RPC schemas; Standard Schema accepted by
opencode). Dev only: `typescript`, `@opentui/solid`, `@opentui/core`, `solid-js`, `@opencode/theme` (types for the TUI entry).
RunPod is called with plain `fetch`; no RunPod SDK.

Dev loop: global `~/.config/opencode/opencode.json` → `"plugins": [{ "package": "/Volumes/dev/projects/runpod-opencode", "options": {…} }]`,
then `opencode service restart`. Sources are watched; edits reload.

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
  "deleteOnExit": true,                     // delete owned endpoints when opencode shuts down
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

## 5. Server plugin

### 5.1 Provider registration
`ctx.provider.transform` adds provider `runpod` ("RunPod Serverless"), `package "@opencode/ai/providers/openai-compatible"`,
`settings: { baseURL: "https://api.runpod.ai/v2/pending/openai/v1", apiKey, provider: "runpod", timeout: 600000, chunkTimeout: 600000 }`,
`activation: "enabled"`. One `Model.Info` per configured model: `modelID`, `name`, `capabilities: { tools, input:["text"], output:["text"] }`,
`limit: { context, output }`, `cost` zero (GPU time is not per-token; real $ is tracked by the plugin). If no API key is
available the provider is still registered so the models are visible; using one throws an actionable error.

### 5.2 Endpoint manager (state machine, one per model)
```
cold ──ensureReady──▶ confirming ──yes──▶ creating ──▶ warming ──▶ ready
  ▲                      │no                                 │            │ idleTimeout elapsed on RunPod (workers 0)
  │                      └─▶ declined (throw)                │            ▼
  └───────────── deleting ◀─── down / exit ◀─────────────────┴──────── idle  ──next request──▶ warming (no confirm)
```
- `ensureReady(modelID)` → `baseURL`. Concurrent callers share one in-flight promise per model.
- **confirming**: build quote (§5.4); if `confirm` is false or the call comes from `/runpod-up`, skip. Otherwise emit RPC event
  `confirm.requested {requestID, quote}` and await RPC method `confirm {requestID, accepted}` up to `confirmTimeoutSec`;
  timeout or `accepted:false` → throw `RunPod: provisioning of <model> declined/unanswered. Run /runpod-up <model> or set options.confirm=false.`
- **creating**: `POST /v2/serverless` with body from `body.ts`: name `oc-runpod-<modelID>`, `type QUEUE`, `gpu {pools:[gpu], count, minCudaVersion}`,
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
- Startup reconcile: `GET /v2/serverless`, take names `oc-runpod-*`. Name matches a configured model and `OPENCODE_RUNPOD_HASH` equals the
  current envHash → adopt (state `idle`) when `adoptExisting`; otherwise, or when the hash differs → delete when `deleteOnExit`
  (log it), else leave untouched and report in status.
- Cleanup fn (plugin dispose / opencode shutdown): when `deleteOnExit`, delete all owned endpoints with a 10 s total budget, best effort, errors logged.

### 5.3 model.request hook
`ctx.session.hook("model.request", async (e) => { e.baseURL = await manager.ensureReady(e.model.id, { sessionID: e.sessionID, kind: e.kind }) }, { providerID: "runpod" })`.
Errors thrown here surface in the session as the request error. No changes to headers (apiKey comes from provider settings).

### 5.4 Pricing (`pricing.ts`, pure functions + one catalog fetch)
- `quote(model)`: pool → `$/h` from `GET /v2/catalog/gpus` (`price.serverless`, cached 10 min) with static table fallback; `× gpuCount`;
  `weightsGb` from config or HF lookup (`GET https://huggingface.co/api/models/{hf}?blobs=true`, sum of `*.safetensors` sizes, cached in storage);
  `estColdStartSec = 45 + weightsGb × 3.5` (heuristic, shown as "≈"); `idleWindowUsd = rate × idleTimeout / 3600`; `fits`: warn when
  `weightsGb > poolVram × 0.85`. Refuse when `rate > maxHourlyRate`.
- `spend(model)`: local estimate `rate × (warmingSec + readySecWithWorkers)/3600` where "with workers" is measured between warm-up start and the
  last request + idleTimeout; plus actual from `GET /v2/billing/serverless?endpointId=` when the call succeeds. Status shows both.

### 5.5 Commands (server, work in any client)
- `/runpod-status` — per configured model: state, endpoint id, GPU, $/h, warm/cold, session spend (est. + billed), orphans found.
- `/runpod-up <model>` — provision without dialog (explicit command = consent), then warm up.
- `/runpod-down [model|all]` — scale to zero and delete.
Replies are posted with `ctx.session.synthetic` if verified not to trigger a model turn (§9); otherwise via RPC `notice` event (TUI toast) only.

### 5.6 RPC contract (`shared/rpc.ts`, zod schemas)
- methods: `status() → {models:[{modelID, phase, endpointID?, gpu, ratePerHour, spendUsd, billedUsd?, lastRequestAt?}]}`,
  `up({modelID})`, `down({modelID?})`, `confirm({requestID, accepted})`.
- events: `confirm.requested {requestID, modelID, quote:{gpu, gpuCount, ratePerHour, estColdStartSec, idleTimeout, idleWindowUsd, weightsGb?, warnings:[]}}`,
  `state {modelID, phase, detail?, elapsedSec?, spendUsd, ratePerHour}`, `notice {level, message}`.

## 6. TUI plugin (`tui.ts`)
- `client.rpc(RunpodRpc).events.on("confirm.requested")` → `ui.dialog.confirm({ title: "RunPod: provision GPU endpoint?", message: "<model> on <gpu>×<n> — $<rate>/h while warm · cold start ≈<m> min · idle window <s>s (≈$<x>) · weights ≈<gb> GB[ · WARN …]" })`
  → `rpc.confirm({ requestID, accepted: ok === true })`. Multiple TUIs: first reply wins; server ignores later ones.
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
| Cleanup failure at exit | logged; never blocks shutdown; next startup reconcile deletes orphans |
| Two plugin instances (global + project config) | both adopt by name; last one out deletes; documented caveat |

## 8. Testing
- Unit (`node --test`, TS): config schema + defaults + presets; `body.ts` (env mapping, parsers, disk, hash stability); `pricing.ts`
  (quote math, fallback table, fit warnings, maxHourlyRate); health → phase mapping; manager FSM with fake client + fake timers
  (confirm accept/decline/timeout, in-flight dedupe, warm-up timeout, idle re-warm, reconcile adopt/orphan, teardown order);
  RPC schema round-trips.
- Smoke (opt-in, `RUNPOD_API_KEY`): `scripts/smoke.ts` creates `Qwen/Qwen3-0.6B` on `AMPERE_16`, warms, sends one request, deletes; asserts spend < $0.10.
- Manual e2e: load via local path in the user's global config; `/models` shows `runpod/*`; pick one, prompt → dialog → toasts → answer; `/runpod-status`; quit → endpoint gone in RunPod console.

## 9. Open verification items (first implementation tasks)
1. `ctx.session.synthetic` — does it trigger a model turn? Decide command reply channel accordingly.
2. Local directory plugin loading: does `Host.resolve(directory)` pick up `index.ts`/`tui.ts`/`rpc.ts` at the repo root? Else use `.opencode/plugins/` symlink.
3. `{env:}` substitution in plugin options.
4. Exact `Provider.Info` / `Model.Info` required fields via `Provider.Info.empty(id)` + tsc.

## 10. Out of scope (v1)
Network volumes and pod (non-serverless) instances; automatic GPU tier selection; daily/weekly budget caps; load-balancer endpoints;
SGLang worker env mapping (image is configurable but env keys are vLLM's); v1 plugin API; per-token cost accounting in opencode's session $.
