# opencode-runpod Plugin Implementation Plan (hexagonal)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opencode v2 plugin (`opencode-runpod`) exposing a `runpod` provider whose models run on RunPod Serverless vLLM endpoints, provisioned lazily per model after a cost-quote confirmation, scaled to zero when idle, deleted when opencode exits, with toasts and a footer status line showing state and spend.

**Architecture:** Hexagonal. `src/core` holds the domain (pure types and math) and the application service `EndpointService` (the lifecycle state machine) which talks only to **ports** (interfaces). `src/adapters/driven` implements the ports: RunPod REST v2 (compute + price catalog), vLLM worker recipe, Hugging Face weights, opencode storage/RPC, system clock/logger. `src/adapters/driving` drives the core: the opencode plugin (composition root, `model.request` hook, slash commands, RPC methods), the TUI plugin, and the RPC contract/formatting shared by UIs. An architecture test enforces the dependency rule.

**Tech Stack:** TypeScript (ESM, run directly — no build step), `@opencode/plugin` ^2.0.16, `zod` 4, RunPod REST v2 via `fetch`, `node:test` (Node ≥ 22 strips types), `tsc --noEmit`, opentui/solid JSX for the TUI slot.

**Spec:** `docs/superpowers/specs/2026-09-26-opencode-runpod-plugin-design.md`

## Global Constraints

- Target opencode **v2** plugin API only: `@opencode/plugin` `^2.0.16`; installed binary `opencode v2.0.16`. No v1 (`@opencode-ai/plugin`) code.
- Runtime is opencode's embedded Bun; tests run under Node 26 with native type stripping. **Erasable TypeScript only**: no `enum`, no constructor parameter properties, no decorators, no `namespace`. `tsconfig` enforces this (`erasableSyntaxOnly`).
- Every relative import uses an explicit `.ts`/`.tsx` extension.
- Dependency rule (enforced by `test/architecture.test.ts`): `src/core/**` imports only `src/core/**` and `node:*`; `src/adapters/driven/<name>/**` imports `src/core/**`, its own folder, `node:*`, npm — never driving code or another driven adapter; `src/adapters/driving/**` imports `src/core/**`, `src/adapters/driving/**`, `node:*`, npm; only `src/adapters/driving/opencode/plugin.ts` (composition root) may import `src/adapters/driven/**`.
- Runtime dependencies: `@opencode/plugin`, `zod` only. `@opentui/core`, `@opentui/solid`, `solid-js` are peerDependencies (host-provided) and devDependencies (types). No RunPod SDK.
- RunPod REST v2 base `https://api.runpod.io/v2`; runtime base `https://api.runpod.ai/v2`; header `Authorization: Bearer <key>`. Endpoint names `oc-runpod-<modelID>`; env markers `OPENCODE_RUNPOD=1`, `OPENCODE_RUNPOD_HASH=<hash>`.
- Defaults (spec §4): `confirm true`, `confirmTimeoutSec 120`, `idleTimeout 120`, `workersMax 1`, `executionTimeoutSec 600`, `coldStartTimeoutSec 600`, `deleteOnExit true`, `adoptExisting true`, `minCudaVersion "12.8"`, `workerImage "runpod/worker-v1-vllm:v2.27.2"`, `flashboot true`.
- Provider id `runpod`, package `@opencode/ai/providers/openai-compatible`, placeholder baseURL `https://api.runpod.ai/v2/pending/openai/v1`, request timeouts 600000 ms.
- Secrets (RunPod key, HF token) live only in adapters; never in `Settings`, logs, toasts, storage, RPC events, or the spec hash.
- Commit messages: conventional prefix, no AI attribution trailers (user rule).
- Before every commit: `npm run check` (= `tsc --noEmit` + `node --test 'test/**/*.test.ts'`) must pass.

## File structure

```
runpod-opencode/
├─ package.json  tsconfig.json  .opencode/opencode.jsonc  README.md  examples/opencode.jsonc  scripts/smoke.ts
├─ index.ts → src/adapters/driving/opencode/plugin.ts   tui.ts → src/adapters/driving/tui/plugin.tsx   rpc.ts → src/adapters/driving/rpc/contract.ts
├─ src/core/domain/
│  ├─ model.ts          ModelConfig, Settings, findModel
│  ├─ endpoint.ts       Phase, WorkerRecipe, EndpointSpec, EndpointRecord, ENDPOINT_PREFIX, endpointName, modelIDFromName, specHash, specHashFor, buildEndpointSpec
│  ├─ quote.ts          PoolRate, Quote, DEFAULT_WEIGHTS_GB, estimateColdStartSec, idleWindowUsd, buildQuote
│  ├─ spend-meter.ts    SpendMeter
│  └─ events.ts         StateEvent, NoticeLevel, ModelStatus, StatusReport
├─ src/core/ports/
│  ├─ compute-provider.ts  ComputeProviderPort, RemoteEndpoint, HealthSnapshot, ComputeError
│  ├─ price-catalog.ts  PriceCatalogPort        ├─ worker-recipe.ts  WorkerRecipePort      ├─ weights-info.ts  WeightsInfoPort
│  ├─ state-store.ts    StateStorePort          ├─ clock.ts          ClockPort             ├─ confirmation.ts  ConfirmationPort
│  ├─ notifier.ts       NotifierPort            ├─ logger.ts         LoggerPort            └─ driving.ts       ModelRoutingPort, OperationsPort, LifecyclePort
├─ src/core/application/endpoint-service.ts   EndpointService
├─ src/adapters/driven/runpod/   types.ts, http.ts (RunpodHttp, RunpodError), compute-provider.ts (RunpodComputeProvider), pools.ts (POOLS), price-catalog.ts (RunpodPriceCatalog)
├─ src/adapters/driven/vllm/     presets.ts (FAMILIES, inferFamily, parsersFor), recipe.ts (VllmWorkerRecipe, diskGb)
├─ src/adapters/driven/huggingface/weights-info.ts   fetchWeightsGb, HfWeightsInfo
├─ src/adapters/driven/opencode/ state-store.ts (OpencodeStateStore), notifier.ts (RpcNotifier), confirmation.ts (ConfirmBroker, RpcConfirmation)
├─ src/adapters/driven/system/   clock.ts (SystemClock), logger.ts (ConsoleLogger)
├─ src/adapters/driving/rpc/     contract.ts (zod DTOs + RunpodRpc), format.ts
├─ src/adapters/driving/opencode/ config.ts (resolveSettings), provider-catalog.ts, commands.ts, plugin.ts
├─ src/adapters/driving/tui/     toasts.ts, plugin.tsx
└─ test/  architecture.test.ts, fakes/{clock,store,compute,catalog,weights,recipe,confirmation,notifier,logger,fixtures}.ts, *.test.ts
```

---

### Task 1: Scaffold, architecture test, core domain types

**Files:**
- Create: `package.json`, `tsconfig.json`, `index.ts`, `tui.ts`, `.opencode/opencode.jsonc`, `src/adapters/driving/opencode/plugin.ts` (stub), `src/adapters/driving/tui/plugin.tsx` (stub)
- Create: `src/core/domain/model.ts`, `src/core/domain/endpoint.ts`, `src/core/domain/events.ts`
- Test: `test/architecture.test.ts`, `test/domain-endpoint.test.ts`

**Interfaces:**
- Produces (`model.ts`): `interface ModelConfig { id; name; hf; gpu; gpuCount; context; output; tools; family: string | null; toolParser: string | null | undefined; reasoningParser: string | null | undefined; quantization: string | null; weightsGb: number | null; env: Record<string,string> }`, `interface Settings { confirm; confirmTimeoutSec; idleTimeout; workersMax; executionTimeoutSec; coldStartTimeoutSec; deleteOnExit; adoptExisting; maxHourlyRate: number | null; dataCenterIds: string[]; minCudaVersion; workerImage; flashboot; models: ModelConfig[] }`, `findModel(settings, modelID)`.
- Produces (`endpoint.ts`): `type Phase`, `interface WorkerRecipe { image; env; secretEnv; diskGb }`, `interface EndpointSpec { name; modelID; recipe; gpu: { pool; count; minCudaVersion }; workers: { min; max; idleTimeoutSec }; executionTimeoutSec; flashboot; dataCenterIds; hash }`, `interface EndpointRecord { endpointID; name; modelID; gpu; gpuCount; hash; createdAt; spendUsd }`, `ENDPOINT_PREFIX`, `endpointName(modelID)`, `modelIDFromName(name): string | null`, `specHash({ image, env, gpu })`, `specHashFor(model, settings, recipe)`, `buildEndpointSpec(model, settings, recipe)`.
- Produces (`events.ts`): `interface StateEvent { modelID; phase; detail: string | null; elapsedSec: number | null; spendUsd; ratePerHour; gpu; gpuLabel }`, `type NoticeLevel`, `interface ModelStatus`, `interface StatusReport { models: ModelStatus[]; orphans: { id; name }[] }`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "opencode-runpod",
  "version": "0.1.0",
  "description": "opencode v2 plugin: per-model RunPod Serverless vLLM endpoints with cost confirmation, scale-to-zero and delete-on-exit",
  "type": "module",
  "license": "MIT",
  "exports": {
    ".": "./index.ts",
    "./tui": "./tui.ts",
    "./rpc": "./rpc.ts"
  },
  "files": ["index.ts", "tui.ts", "rpc.ts", "src", "README.md"],
  "scripts": {
    "test": "node --test 'test/**/*.test.ts'",
    "typecheck": "tsc --noEmit",
    "check": "npm run typecheck && npm test",
    "smoke": "node scripts/smoke.ts"
  },
  "dependencies": {
    "@opencode/plugin": "^2.0.16",
    "zod": "^4.1.8"
  },
  "peerDependencies": {
    "@opentui/core": ">=0.5.10",
    "@opentui/solid": ">=0.5.10",
    "solid-js": ">=1.9.0"
  },
  "devDependencies": {
    "@opencode/theme": "^2.0.16",
    "@opentui/core": "^0.5.12",
    "@opentui/solid": "^0.5.12",
    "@types/node": "^24.0.0",
    "solid-js": "^1.9.0",
    "typescript": "^5.9.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023"],
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "skipLibCheck": true,
    "types": ["node"],
    "jsx": "preserve",
    "jsxImportSource": "@opentui/solid"
  },
  "include": ["index.ts", "tui.ts", "rpc.ts", "src/**/*", "test/**/*", "scripts/**/*"]
}
```

- [ ] **Step 3: Create root entries, stubs and the dev config**

`index.ts`:
```ts
export { default } from "./src/adapters/driving/opencode/plugin.ts"
```

`tui.ts`:
```ts
export { default } from "./src/adapters/driving/tui/plugin.tsx"
```

`src/adapters/driving/opencode/plugin.ts` (temporary stub, replaced in Task 14):
```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "runpod",
  setup() {},
})
```

`src/adapters/driving/tui/plugin.tsx` (temporary stub, replaced in Task 15):
```tsx
import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "runpod.tui",
  setup() {},
})
```

`.opencode/opencode.jsonc` (dev config; `../` is resolved relative to this file, i.e. the repo root):
```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "../",
      "options": {
        "confirm": true,
        "idleTimeout": 60,
        "models": {
          "qwen3-0.6b": {
            "name": "Qwen3 0.6B (RunPod dev)",
            "hf": "Qwen/Qwen3-0.6B",
            "gpu": "AMPERE_16",
            "context": 8192,
            "output": 2048,
            "family": "qwen3"
          }
        }
      }
    }
  ]
}
```

- [ ] **Step 4: Install dependencies and confirm the harness runs**

Run: `cd /Volumes/dev/projects/runpod-opencode && npm install && npm run typecheck && npm test`
Expected: install succeeds, tsc clean, `node --test` reports 0 tests (exit 0). If the glob is not expanded, change the test script to `node --test test/`.

- [ ] **Step 5: Write the failing tests**

`test/architecture.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const SRC = path.resolve(import.meta.dirname, "../src")
const ROOT = path.resolve(SRC, "..")
const COMPOSITION_ROOT = "src/adapters/driving/opencode/plugin.ts"

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

function importsOf(file: string): string[] {
  const specs: string[] = []
  for (const match of readFileSync(file, "utf8").matchAll(/(?:from|import)\s+"([^"]+)"/g)) specs.push(match[1]!)
  return specs
}

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/")
const isLocal = (spec: string) => spec.startsWith("./") || spec.startsWith("../")
const target = (file: string, spec: string) => rel(path.resolve(path.dirname(file), spec))

test("core imports only core and node builtins", () => {
  for (const file of walk(path.join(SRC, "core"))) {
    for (const spec of importsOf(file)) {
      if (isLocal(spec)) assert.ok(target(file, spec).startsWith("src/core/"), `${rel(file)} imports ${spec}`)
      else assert.ok(spec.startsWith("node:"), `${rel(file)} imports package ${spec}`)
    }
  }
})

test("driven adapters import only core and their own folder", () => {
  for (const file of walk(path.join(SRC, "adapters", "driven"))) {
    const own = rel(file).split("/").slice(0, 4).join("/") // src/adapters/driven/<name>
    for (const spec of importsOf(file)) {
      if (!isLocal(spec)) continue
      const t = target(file, spec)
      assert.ok(t.startsWith("src/core/") || t.startsWith(`${own}/`), `${rel(file)} imports ${spec}`)
    }
  }
})

test("driving adapters import core and driving only; the composition root may import driven adapters", () => {
  for (const file of walk(path.join(SRC, "adapters", "driving"))) {
    if (rel(file) === COMPOSITION_ROOT) continue
    for (const spec of importsOf(file)) {
      if (!isLocal(spec)) continue
      const t = target(file, spec)
      assert.ok(t.startsWith("src/core/") || t.startsWith("src/adapters/driving/"), `${rel(file)} imports ${spec}`)
    }
  }
})

test("domain, ports and application directories exist", () => {
  for (const dir of ["core/domain", "core/ports", "core/application", "adapters/driven", "adapters/driving"]) {
    assert.ok(statSync(path.join(SRC, dir)).isDirectory(), dir)
  }
})
```

`test/domain-endpoint.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { ENDPOINT_PREFIX, buildEndpointSpec, endpointName, modelIDFromName, specHash, specHashFor, type WorkerRecipe } from "../src/core/domain/endpoint.ts"
import { findModel, type ModelConfig, type Settings } from "../src/core/domain/model.ts"

const model: ModelConfig = { id: "m", name: "M", hf: "Qwen/Qwen3-8B", gpu: "AMPERE_48", gpuCount: 2, context: 32768, output: 8192, tools: true, family: null, toolParser: undefined, reasoningParser: undefined, quantization: null, weightsGb: null, env: {} }
const settings: Settings = { confirm: true, confirmTimeoutSec: 120, idleTimeout: 90, workersMax: 3, executionTimeoutSec: 600, coldStartTimeoutSec: 600, deleteOnExit: true, adoptExisting: true, maxHourlyRate: null, dataCenterIds: ["EU-RO-1"], minCudaVersion: "12.8", workerImage: "img:v1", flashboot: false, models: [model] }
const recipe: WorkerRecipe = { image: "img:v1", env: { MODEL_NAME: "Qwen/Qwen3-8B", MAX_MODEL_LEN: "32768" }, secretEnv: { HF_TOKEN: "hf_secret" }, diskGb: 30 }

test("endpoint names round-trip through the prefix", () => {
  assert.equal(endpointName("abc"), `${ENDPOINT_PREFIX}abc`)
  assert.equal(modelIDFromName("oc-runpod-abc"), "abc")
  assert.equal(modelIDFromName("oc-runpod-"), null)
  assert.equal(modelIDFromName("other"), null)
})

test("specHash is 16 hex chars, stable, order-independent and sensitive to image/env/gpu", () => {
  const base = { image: "img:v1", env: { A: "1", B: "2" }, gpu: { pool: "AMPERE_48", count: 2, minCudaVersion: "12.8" } }
  const h = specHash(base)
  assert.match(h, /^[0-9a-f]{16}$/)
  assert.equal(specHash({ ...base, env: { B: "2", A: "1" } }), h)
  assert.notEqual(specHash({ ...base, image: "img:v2" }), h)
  assert.notEqual(specHash({ ...base, env: { A: "1", B: "3" } }), h)
  assert.notEqual(specHash({ ...base, gpu: { ...base.gpu, count: 1 } }), h)
})

test("buildEndpointSpec copies settings and hashes only non-secret env", () => {
  const spec = buildEndpointSpec(model, settings, recipe)
  assert.equal(spec.name, "oc-runpod-m")
  assert.equal(spec.modelID, "m")
  assert.deepEqual(spec.gpu, { pool: "AMPERE_48", count: 2, minCudaVersion: "12.8" })
  assert.deepEqual(spec.workers, { min: 0, max: 3, idleTimeoutSec: 90 })
  assert.equal(spec.executionTimeoutSec, 600)
  assert.equal(spec.flashboot, false)
  assert.deepEqual(spec.dataCenterIds, ["EU-RO-1"])
  assert.equal(spec.recipe, recipe)
  assert.equal(spec.hash, specHashFor(model, settings, recipe))
  const withoutSecret = buildEndpointSpec(model, settings, { ...recipe, secretEnv: {} })
  assert.equal(withoutSecret.hash, spec.hash)
})

test("findModel", () => {
  assert.equal(findModel(settings, "m"), model)
  assert.equal(findModel(settings, "nope"), undefined)
})
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `npm test`
Expected: architecture test fails on missing directories (`core/domain` …); domain test fails with cannot find module.

- [ ] **Step 7: Implement the domain files**

`src/core/domain/model.ts`:
```ts
export interface ModelConfig {
  id: string
  name: string
  /** Hugging Face repo id, e.g. "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8". */
  hf: string
  /** Compute pool identifier (RunPod serverless pool id such as "AMPERE_48"). */
  gpu: string
  gpuCount: number
  context: number
  output: number
  tools: boolean
  /** Explicit model family (e.g. "qwen3-coder") or null → the worker recipe may infer it from `hf`. */
  family: string | null
  /** undefined → recipe preset; null → disabled; string → explicit parser name. */
  toolParser: string | null | undefined
  reasoningParser: string | null | undefined
  quantization: string | null
  weightsGb: number | null
  env: Record<string, string>
}

export interface Settings {
  confirm: boolean
  confirmTimeoutSec: number
  idleTimeout: number
  workersMax: number
  executionTimeoutSec: number
  coldStartTimeoutSec: number
  deleteOnExit: boolean
  adoptExisting: boolean
  maxHourlyRate: number | null
  dataCenterIds: string[]
  minCudaVersion: string
  workerImage: string
  flashboot: boolean
  models: ModelConfig[]
}

export function findModel(settings: Settings, modelID: string): ModelConfig | undefined {
  return settings.models.find((m) => m.id === modelID)
}
```

`src/core/domain/endpoint.ts`:
```ts
import { createHash } from "node:crypto"
import type { ModelConfig, Settings } from "./model.ts"

export type Phase = "cold" | "confirming" | "creating" | "warming" | "ready" | "idle" | "deleting" | "error"

/** Container recipe produced by a WorkerRecipePort. `secretEnv` is never hashed or logged. */
export interface WorkerRecipe {
  image: string
  env: Record<string, string>
  secretEnv: Record<string, string>
  diskGb: number
}

export interface EndpointSpec {
  name: string
  modelID: string
  recipe: WorkerRecipe
  gpu: { pool: string; count: number; minCudaVersion: string }
  workers: { min: number; max: number; idleTimeoutSec: number }
  executionTimeoutSec: number
  flashboot: boolean
  dataCenterIds: string[]
  /** Configuration fingerprint; stored on the remote endpoint so reconcile can compare. */
  hash: string
}

export interface EndpointRecord {
  endpointID: string
  name: string
  modelID: string
  gpu: string
  gpuCount: number
  hash: string
  createdAt: number
  spendUsd: number
}

export const ENDPOINT_PREFIX = "oc-runpod-"

export function endpointName(modelID: string): string {
  return `${ENDPOINT_PREFIX}${modelID}`
}

export function modelIDFromName(name: string): string | null {
  if (!name.startsWith(ENDPOINT_PREFIX)) return null
  const id = name.slice(ENDPOINT_PREFIX.length)
  return id.length > 0 ? id : null
}

export function specHash(input: { image: string; env: Record<string, string>; gpu: { pool: string; count: number; minCudaVersion: string } }): string {
  return createHash("sha256").update(stableJson(input)).digest("hex").slice(0, 16)
}

export function specHashFor(model: ModelConfig, settings: Settings, recipe: WorkerRecipe): string {
  return specHash({
    image: recipe.image,
    env: recipe.env,
    gpu: { pool: model.gpu, count: model.gpuCount, minCudaVersion: settings.minCudaVersion },
  })
}

export function buildEndpointSpec(model: ModelConfig, settings: Settings, recipe: WorkerRecipe): EndpointSpec {
  return {
    name: endpointName(model.id),
    modelID: model.id,
    recipe,
    gpu: { pool: model.gpu, count: model.gpuCount, minCudaVersion: settings.minCudaVersion },
    workers: { min: 0, max: settings.workersMax, idleTimeoutSec: settings.idleTimeout },
    executionTimeoutSec: settings.executionTimeoutSec,
    flashboot: settings.flashboot,
    dataCenterIds: [...settings.dataCenterIds],
    hash: specHashFor(model, settings, recipe),
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`
  }
  return JSON.stringify(value)
}
```

`src/core/domain/events.ts`:
```ts
import type { Phase } from "./endpoint.ts"

export interface StateEvent {
  modelID: string
  phase: Phase
  detail: string | null
  elapsedSec: number | null
  spendUsd: number
  /** $/h for the whole worker (pool rate × gpuCount). */
  ratePerHour: number
  gpu: string
  gpuLabel: string
}

export type NoticeLevel = "info" | "warning" | "error"

export interface ModelStatus {
  modelID: string
  phase: Phase
  detail: string | null
  spendUsd: number
  ratePerHour: number
  gpu: string
  gpuLabel: string
  endpointID: string | null
  gpuCount: number
  billedUsd: number | null
  lastRequestAt: number | null
}

export interface StatusReport {
  models: ModelStatus[]
  orphans: { id: string; name: string }[]
}
```

Also create the empty directories the architecture test expects by adding the first port file now — `src/core/ports/driving.ts`:
```ts
import type { StatusReport } from "../domain/events.ts"

/** Driving port used by the model.request hook: make the model reachable and return its inference base URL. */
export interface ModelRoutingPort {
  ensureReady(modelID: string, opts?: { skipConfirm?: boolean }): Promise<string>
}

/** Driving port used by commands and RPC methods. */
export interface OperationsPort {
  status(): Promise<StatusReport>
  up(modelID: string): Promise<string>
  down(modelID?: string): Promise<string[]>
}

/** Driving port used by the plugin lifecycle. */
export interface LifecyclePort {
  start(): Promise<void>
  stop(budgetMs?: number): Promise<void>
}
```
and create two placeholders so the directory checks pass before those layers have files: `src/core/application/.gitkeep` (removed in Task 3) and `src/adapters/driven/.gitkeep` (removed in Task 6).

- [ ] **Step 8: Run tests and typecheck**

Run: `npm run check`
Expected: all tests pass, tsc clean.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json index.ts tui.ts .opencode/opencode.jsonc src test
git commit -m "chore: scaffold opencode-runpod with hexagonal layout, domain types and architecture test"
```

---

### Task 2: Domain pricing math and spend meter

**Files:**
- Create: `src/core/domain/quote.ts`, `src/core/domain/spend-meter.ts`
- Test: `test/domain-quote.test.ts`

**Interfaces:**
- Produces: `interface PoolRate { ratePerHour: number; source: "catalog" | "fallback"; vramGb: number | null; label: string }`, `interface Quote { modelID; hf; gpu; gpuLabel; gpuCount; ratePerHour; rateSource; weightsGb: number | null; estColdStartSec; idleTimeout; idleWindowUsd; warnings: string[]; blocked: string | null }`, `DEFAULT_WEIGHTS_GB = 60`, `estimateColdStartSec(weightsGb)`, `idleWindowUsd(ratePerHour, idleTimeoutSec)`, `buildQuote({ model, settings, rate, weightsGb })`, `class SpendMeter { constructor(now: () => number); start(ratePerHour, at?); stop(at?); usd(at?); readonly running }`.

- [ ] **Step 1: Write the failing test**

`test/domain-quote.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_WEIGHTS_GB, buildQuote, estimateColdStartSec, idleWindowUsd, type PoolRate } from "../src/core/domain/quote.ts"
import { SpendMeter } from "../src/core/domain/spend-meter.ts"
import type { ModelConfig, Settings } from "../src/core/domain/model.ts"

const model: ModelConfig = { id: "m", name: "M", hf: "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8", gpu: "AMPERE_48", gpuCount: 2, context: 65536, output: 8192, tools: true, family: null, toolParser: undefined, reasoningParser: undefined, quantization: "fp8", weightsGb: null, env: {} }
const settings: Settings = { confirm: true, confirmTimeoutSec: 120, idleTimeout: 120, workersMax: 1, executionTimeoutSec: 600, coldStartTimeoutSec: 600, deleteOnExit: true, adoptExisting: true, maxHourlyRate: null, dataCenterIds: [], minCudaVersion: "12.8", workerImage: "img", flashboot: true, models: [model] }
const catalogRate: PoolRate = { ratePerHour: 1.3, source: "catalog", vramGb: 48, label: "A6000/A40 48GB" }
const fallbackRate: PoolRate = { ratePerHour: 1.22, source: "fallback", vramGb: 48, label: "A6000/A40 48GB" }

test("cold start estimate and idle window math", () => {
  assert.equal(estimateColdStartSec(null), 180)
  assert.equal(estimateColdStartSec(30), 45 + 105)
  assert.equal(idleWindowUsd(1.2, 120), 0.04)
  assert.equal(DEFAULT_WEIGHTS_GB, 60)
})

test("buildQuote multiplies by gpuCount and warns on fallback pricing", () => {
  const q = buildQuote({ model, settings, rate: fallbackRate, weightsGb: 31.6 })
  assert.equal(q.modelID, "m")
  assert.equal(q.hf, model.hf)
  assert.equal(q.gpuLabel, "A6000/A40 48GB")
  assert.equal(q.gpuCount, 2)
  assert.equal(q.ratePerHour, 2.44)
  assert.equal(q.rateSource, "fallback")
  assert.equal(q.weightsGb, 31.6)
  assert.equal(q.estColdStartSec, estimateColdStartSec(31.6))
  assert.equal(q.idleTimeout, 120)
  assert.equal(q.idleWindowUsd, idleWindowUsd(2.44, 120))
  assert.equal(q.blocked, null)
  assert.ok(q.warnings.some((w) => /static/.test(w)))
})

test("buildQuote warns when weights may not fit, unknown size, and blocks above maxHourlyRate or unknown pool", () => {
  const tight = buildQuote({ model: { ...model, gpuCount: 1 }, settings: { ...settings, maxHourlyRate: 1.0 }, rate: catalogRate, weightsGb: 45 })
  assert.ok(tight.warnings.some((w) => /may not fit 48 GB/.test(w)))
  assert.match(tight.blocked ?? "", /\$1\.30\/h exceeds options\.maxHourlyRate \$1\.00/)
  const unknownSize = buildQuote({ model, settings, rate: catalogRate, weightsGb: null })
  assert.ok(unknownSize.warnings.some((w) => /size unknown/.test(w)))
  assert.equal(unknownSize.blocked, null)
  const unknownPool = buildQuote({ model, settings, rate: { ratePerHour: 0, source: "fallback", vramGb: null, label: "NOPE" }, weightsGb: 10 })
  assert.match(unknownPool.blocked ?? "", /no price known for GPU pool "AMPERE_48"/)
})

test("SpendMeter accumulates only while running and can be stopped retroactively", () => {
  let now = 0
  const meter = new SpendMeter(() => now)
  assert.equal(meter.usd(), 0)
  meter.start(3.6) // $3.6/h = $0.001/s
  now = 10_000
  assert.equal(meter.running, true)
  assert.ok(Math.abs(meter.usd() - 0.01) < 1e-9)
  meter.stop(5_000) // scaled down at t=5s even though noticed at t=10s
  assert.equal(meter.running, false)
  assert.ok(Math.abs(meter.usd() - 0.005) < 1e-9)
  now = 20_000
  meter.start(3.6)
  now = 30_000
  assert.ok(Math.abs(meter.usd() - 0.015) < 1e-9)
  meter.stop()
  assert.ok(Math.abs(meter.usd() - 0.015) < 1e-9)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find `src/core/domain/quote.ts`.

- [ ] **Step 3: Implement `src/core/domain/quote.ts`**

```ts
import type { ModelConfig, Settings } from "./model.ts"

export interface PoolRate {
  /** $/h for ONE GPU of the pool. */
  ratePerHour: number
  source: "catalog" | "fallback"
  vramGb: number | null
  label: string
}

export interface Quote {
  modelID: string
  hf: string
  gpu: string
  gpuLabel: string
  gpuCount: number
  /** $/h for the whole worker (pool rate × gpuCount). */
  ratePerHour: number
  rateSource: "catalog" | "fallback"
  weightsGb: number | null
  estColdStartSec: number
  idleTimeout: number
  idleWindowUsd: number
  warnings: string[]
  /** Non-null when provisioning must be refused. */
  blocked: string | null
}

export const DEFAULT_WEIGHTS_GB = 60

/** Heuristic: ~45 s container/engine start + ~3.5 s per GB pulled and loaded. Unknown size → 3 min. */
export function estimateColdStartSec(weightsGb: number | null): number {
  return weightsGb === null ? 180 : Math.round(45 + weightsGb * 3.5)
}

export function idleWindowUsd(ratePerHour: number, idleTimeoutSec: number): number {
  return Math.round(((ratePerHour * idleTimeoutSec) / 3600) * 1e6) / 1e6
}

export function buildQuote(input: { model: ModelConfig; settings: Settings; rate: PoolRate; weightsGb: number | null }): Quote {
  const { model, settings, rate, weightsGb } = input
  const ratePerHour = Math.round(rate.ratePerHour * model.gpuCount * 1e4) / 1e4
  const warnings: string[] = []
  let blocked: string | null = null
  if (rate.source === "fallback") warnings.push("price from the static table (live catalog unavailable)")
  if (weightsGb === null) warnings.push("weights size unknown; the cold start estimate is a guess")
  if (weightsGb !== null && rate.vramGb !== null && weightsGb > rate.vramGb * model.gpuCount * 0.85) {
    warnings.push(`weights ≈${weightsGb} GB may not fit ${rate.vramGb * model.gpuCount} GB of VRAM`)
  }
  if (rate.ratePerHour === 0) blocked = `no price known for GPU pool "${model.gpu}"`
  if (settings.maxHourlyRate !== null && ratePerHour > settings.maxHourlyRate) {
    blocked = `$${ratePerHour.toFixed(2)}/h exceeds options.maxHourlyRate $${settings.maxHourlyRate.toFixed(2)}`
  }
  return {
    modelID: model.id,
    hf: model.hf,
    gpu: model.gpu,
    gpuLabel: rate.label,
    gpuCount: model.gpuCount,
    ratePerHour,
    rateSource: rate.source,
    weightsGb,
    estColdStartSec: estimateColdStartSec(weightsGb),
    idleTimeout: settings.idleTimeout,
    idleWindowUsd: idleWindowUsd(ratePerHour, settings.idleTimeout),
    warnings,
    blocked,
  }
}
```

- [ ] **Step 4: Implement `src/core/domain/spend-meter.ts`**

```ts
/** Accumulates $ while a worker is believed to be running. */
export class SpendMeter {
  private accumulated = 0
  private rate = 0
  private since: number | null = null
  private readonly now: () => number

  constructor(now: () => number) {
    this.now = now
  }

  start(ratePerHour: number, at: number = this.now()): void {
    if (this.since !== null) this.stop(at)
    this.rate = ratePerHour
    this.since = at
  }

  stop(at: number = this.now()): void {
    if (this.since === null) return
    this.accumulated += (Math.max(0, at - this.since) / 3_600_000) * this.rate
    this.since = null
  }

  usd(at: number = this.now()): number {
    const live = this.since === null ? 0 : (Math.max(0, at - this.since) / 3_600_000) * this.rate
    return this.accumulated + live
  }

  get running(): boolean {
    return this.since !== null
  }
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm run check`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/domain/quote.ts src/core/domain/spend-meter.ts test/domain-quote.test.ts
git commit -m "feat(core): quote math and spend meter"
```

---

### Task 3: Ports, test fakes, and `EndpointService.ensureReady`

**Files:**
- Create: `src/core/ports/compute-provider.ts`, `price-catalog.ts`, `worker-recipe.ts`, `weights-info.ts`, `state-store.ts`, `clock.ts`, `confirmation.ts`, `notifier.ts`, `logger.ts`
- Create: `src/core/application/endpoint-service.ts` (delete `src/core/application/.gitkeep`)
- Create: `test/fakes/clock.ts`, `store.ts`, `compute.ts`, `catalog.ts`, `weights.ts`, `recipe.ts`, `confirmation.ts`, `notifier.ts`, `logger.ts`, `fixtures.ts`
- Test: `test/service-ensure-ready.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–2.
- Produces (ports): see code below — exact names `ComputeProviderPort`, `RemoteEndpoint`, `HealthSnapshot`, `ComputeError` (`kind: "transient" | "fatal"`, `status: number | null`), `PriceCatalogPort`, `WorkerRecipePort`, `WeightsInfoPort`, `StateStorePort`, `ClockPort`, `ConfirmationPort`, `NotifierPort`, `LoggerPort`.
- Produces (application): `interface ServicePorts { compute: ComputeProviderPort | null; catalog; weights; recipe; store; clock; confirmation; notifier; logger }`, `class EndpointService implements ModelRoutingPort { constructor(settings: Settings, ports: ServicePorts); ensureReady(modelID, opts?); phase(modelID): Phase }`, constants `IDLE_GRACE_MS = 15000`, `HEALTH_POLL_MS = 3000`, `WARMUP_RETRY_MS = 5000`. Storage keys `endpoints/<modelID>` (EndpointRecord) and `weights/<hf>` (number).
- Produces (fakes): `FakeClock` (`now/sleep/setTimer/clearTimer/advance(ms)/pending`), `flush()`, `InMemoryStateStore` (`data` map), `FakeCompute` (`remote`, `created`, `calls`, `healthSnapshot`, `diagnosticsText`, `billed`, `failCreate`, `failDelete`, `finishWarmup()`, `failWarmup(err)`, `pendingWarmups`, URLs `https://compute.test/<id>/v1`), `FakeCatalog` (`rates`, `fail`, `calls`), `FakeWeights(value)`, `FakeRecipe`, `ScriptedConfirmation(answers)` (`asked`), `RecordingNotifier` (`events`, `notices`), `RecordingLogger` (`lines`), `sampleModel()`, `sampleSettings()`, `harness(settingsOverrides?, { answers?, weights?, compute? })`.

- [ ] **Step 1: Create the port files**

`src/core/ports/compute-provider.ts`:
```ts
import type { EndpointSpec } from "../domain/endpoint.ts"

export interface RemoteEndpoint {
  id: string
  name: string
  /** Value of the config-hash marker on the remote endpoint, or null when absent. */
  hash: string | null
}

export interface HealthSnapshot {
  initializing: number
  running: number
  idle: number
  throttled: number
}

export type ComputeErrorKind = "transient" | "fatal"

/** Thrown by compute adapters. `fatal` stops warm-up retries (e.g. HTTP 4xx other than 408/429). */
export class ComputeError extends Error {
  readonly kind: ComputeErrorKind
  readonly status: number | null
  constructor(message: string, kind: ComputeErrorKind, status: number | null = null) {
    super(message)
    this.name = "ComputeError"
    this.kind = kind
    this.status = status
  }
}

export interface ComputeProviderPort {
  list(): Promise<RemoteEndpoint[]>
  create(spec: EndpointSpec): Promise<{ id: string }>
  scaleToZero(id: string): Promise<void>
  /** Deleting an already-deleted endpoint resolves normally. */
  delete(id: string): Promise<void>
  health(id: string): Promise<HealthSnapshot>
  /** Forces a cold worker to boot and resolves once it answered a request. */
  warmup(id: string, modelID: string, signal: AbortSignal): Promise<void>
  /** Log tail of an unhealthy worker, or null when nothing useful is available. */
  diagnostics(id: string): Promise<string | null>
  billedUsd(id: string): Promise<number | null>
  inferenceBaseURL(id: string): string
}
```

`src/core/ports/price-catalog.ts`:
```ts
import type { PoolRate } from "../domain/quote.ts"

export interface PriceCatalogPort {
  rate(pool: string): Promise<PoolRate>
  knownPools(): readonly string[]
}
```

`src/core/ports/worker-recipe.ts`:
```ts
import type { WorkerRecipe } from "../domain/endpoint.ts"
import type { ModelConfig, Settings } from "../domain/model.ts"

export interface WorkerRecipePort {
  /** Pure: image, env (non-secret), secretEnv and disk size for a model. `weightsGb` null → default sizing. */
  recipe(model: ModelConfig, settings: Settings, weightsGb: number | null): WorkerRecipe
}
```

`src/core/ports/weights-info.ts`:
```ts
import type { ModelConfig } from "../domain/model.ts"

export interface WeightsInfoPort {
  weightsGb(model: ModelConfig): Promise<number | null>
}
```

`src/core/ports/state-store.ts`:
```ts
export interface StateStorePort {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}
```

`src/core/ports/clock.ts`:
```ts
export interface ClockPort {
  now(): number
  sleep(ms: number): Promise<void>
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(id: unknown): void
}
```

`src/core/ports/confirmation.ts`:
```ts
import type { Quote } from "../domain/quote.ts"

export interface ConfirmationPort {
  /** Resolves true when the user accepts, false when declined or unanswered. */
  ask(quote: Quote): Promise<boolean>
}
```

`src/core/ports/notifier.ts`:
```ts
import type { NoticeLevel, StateEvent } from "../domain/events.ts"

export interface NotifierPort {
  state(event: StateEvent): void
  notice(level: NoticeLevel, message: string): void
}
```

`src/core/ports/logger.ts`:
```ts
export interface LoggerPort {
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
}
```

- [ ] **Step 2: Create the fakes**

`test/fakes/clock.ts`:
```ts
import type { ClockPort } from "../../src/core/ports/clock.ts"

/** Drain microtasks (and one macrotask turn). */
export const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

export class FakeClock implements ClockPort {
  private time = 0
  private seq = 0
  private timers: { id: number; at: number; fn: () => void }[] = []

  now(): number {
    return this.time
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.schedule(ms, () => resolve())
    })
  }

  setTimer(fn: () => void, ms: number): unknown {
    return this.schedule(ms, fn)
  }

  clearTimer(id: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== id)
  }

  get pending(): number {
    return this.timers.length
  }

  /** Advance time, firing due timers in order and draining microtasks after each one. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.timers = this.timers.filter((t) => t.id !== due.id)
      this.time = due.at
      due.fn()
      await flush()
    }
    this.time = target
    await flush()
  }

  private schedule(ms: number, fn: () => void): number {
    const id = ++this.seq
    this.timers.push({ id, at: this.time + ms, fn })
    return id
  }
}
```

`test/fakes/store.ts`:
```ts
import type { StateStorePort } from "../../src/core/ports/state-store.ts"

export class InMemoryStateStore implements StateStorePort {
  readonly data = new Map<string, unknown>()
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined
  }
  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value))
  }
  async remove(key: string): Promise<void> {
    this.data.delete(key)
  }
}
```

`test/fakes/compute.ts`:
```ts
import type { EndpointSpec } from "../../src/core/domain/endpoint.ts"
import type { ComputeProviderPort, HealthSnapshot, RemoteEndpoint } from "../../src/core/ports/compute-provider.ts"

interface PendingWarmup {
  resolve: () => void
  reject: (error: Error) => void
}

export class FakeCompute implements ComputeProviderPort {
  remote: RemoteEndpoint[] = []
  created: EndpointSpec[] = []
  calls: string[] = []
  healthSnapshot: HealthSnapshot = { initializing: 0, running: 0, idle: 0, throttled: 0 }
  diagnosticsText: string | null = null
  billed: number | null = null
  failCreate: Error | null = null
  failDelete: Error | null = null
  private warmups: PendingWarmup[] = []
  private nextId = 1

  async list(): Promise<RemoteEndpoint[]> {
    this.calls.push("list")
    return this.remote.map((e) => ({ ...e }))
  }

  async create(spec: EndpointSpec): Promise<{ id: string }> {
    this.calls.push(`create:${spec.name}`)
    if (this.failCreate) throw this.failCreate
    this.created.push(spec)
    const id = `ep${this.nextId++}`
    this.remote.push({ id, name: spec.name, hash: spec.hash })
    return { id }
  }

  async scaleToZero(id: string): Promise<void> {
    this.calls.push(`scaleToZero:${id}`)
  }

  async delete(id: string): Promise<void> {
    this.calls.push(`delete:${id}`)
    if (this.failDelete) throw this.failDelete
    this.remote = this.remote.filter((e) => e.id !== id)
  }

  async health(id: string): Promise<HealthSnapshot> {
    this.calls.push(`health:${id}`)
    return { ...this.healthSnapshot }
  }

  warmup(id: string, _modelID: string, signal: AbortSignal): Promise<void> {
    this.calls.push(`warmup:${id}`)
    return new Promise<void>((resolve, reject) => {
      const entry: PendingWarmup = { resolve, reject }
      this.warmups.push(entry)
      signal.addEventListener(
        "abort",
        () => {
          this.warmups = this.warmups.filter((w) => w !== entry)
          reject(new Error("aborted"))
        },
        { once: true },
      )
    })
  }

  async diagnostics(id: string): Promise<string | null> {
    this.calls.push(`diagnostics:${id}`)
    return this.diagnosticsText
  }

  async billedUsd(): Promise<number | null> {
    return this.billed
  }

  inferenceBaseURL(id: string): string {
    return `https://compute.test/${id}/v1`
  }

  get pendingWarmups(): number {
    return this.warmups.length
  }

  finishWarmup(): void {
    const w = this.warmups.shift()
    if (!w) throw new Error("no pending warm-up")
    w.resolve()
  }

  failWarmup(error: Error): void {
    const w = this.warmups.shift()
    if (!w) throw new Error("no pending warm-up")
    w.reject(error)
  }
}
```

`test/fakes/catalog.ts`:
```ts
import type { PoolRate } from "../../src/core/domain/quote.ts"
import type { PriceCatalogPort } from "../../src/core/ports/price-catalog.ts"

export class FakeCatalog implements PriceCatalogPort {
  rates: Record<string, PoolRate> = {
    AMPERE_16: { ratePerHour: 0.58, source: "catalog", vramGb: 16, label: "A4000/A4500 16GB" },
    AMPERE_48: { ratePerHour: 1.22, source: "catalog", vramGb: 48, label: "A6000/A40 48GB" },
    AMPERE_80: { ratePerHour: 2.72, source: "catalog", vramGb: 80, label: "A100 80GB" },
  }
  fail = false
  calls = 0

  async rate(pool: string): Promise<PoolRate> {
    this.calls++
    if (this.fail) throw new Error("catalog down")
    return this.rates[pool] ?? { ratePerHour: 0, source: "fallback", vramGb: null, label: pool }
  }

  knownPools(): readonly string[] {
    return Object.keys(this.rates)
  }
}
```

`test/fakes/weights.ts`:
```ts
import type { WeightsInfoPort } from "../../src/core/ports/weights-info.ts"

export class FakeWeights implements WeightsInfoPort {
  value: number | null
  calls = 0
  constructor(value: number | null = 31.6) {
    this.value = value
  }
  async weightsGb(): Promise<number | null> {
    this.calls++
    return this.value
  }
}
```

`test/fakes/recipe.ts`:
```ts
import type { WorkerRecipe } from "../../src/core/domain/endpoint.ts"
import type { ModelConfig, Settings } from "../../src/core/domain/model.ts"
import type { WorkerRecipePort } from "../../src/core/ports/worker-recipe.ts"

export class FakeRecipe implements WorkerRecipePort {
  recipe(model: ModelConfig, settings: Settings, weightsGb: number | null): WorkerRecipe {
    return {
      image: settings.workerImage,
      env: { MODEL_NAME: model.hf, MAX_MODEL_LEN: String(model.context), ...model.env },
      secretEnv: {},
      diskGb: weightsGb === null ? 20 : Math.ceil(weightsGb) + 10,
    }
  }
}
```

`test/fakes/confirmation.ts`:
```ts
import type { Quote } from "../../src/core/domain/quote.ts"
import type { ConfirmationPort } from "../../src/core/ports/confirmation.ts"

/** Answers in order; the last answer repeats. */
export class ScriptedConfirmation implements ConfirmationPort {
  answers: boolean[]
  asked: Quote[] = []
  constructor(answers: boolean[] = [true]) {
    this.answers = [...answers]
  }
  async ask(quote: Quote): Promise<boolean> {
    this.asked.push(quote)
    return this.answers.length > 1 ? this.answers.shift()! : (this.answers[0] ?? true)
  }
}
```

`test/fakes/notifier.ts`:
```ts
import type { NoticeLevel, StateEvent } from "../../src/core/domain/events.ts"
import type { NotifierPort } from "../../src/core/ports/notifier.ts"

export class RecordingNotifier implements NotifierPort {
  events: StateEvent[] = []
  notices: { level: NoticeLevel; message: string }[] = []
  state(event: StateEvent): void {
    this.events.push(event)
  }
  notice(level: NoticeLevel, message: string): void {
    this.notices.push({ level, message })
  }
  get phases(): string[] {
    return this.events.map((e) => e.phase)
  }
}
```

`test/fakes/logger.ts`:
```ts
import type { LoggerPort } from "../../src/core/ports/logger.ts"

export class RecordingLogger implements LoggerPort {
  lines: string[] = []
  info(message: string): void {
    this.lines.push(`info ${message}`)
  }
  warn(message: string): void {
    this.lines.push(`warn ${message}`)
  }
}
```

`test/fakes/fixtures.ts`:
```ts
import { EndpointService, type ServicePorts } from "../../src/core/application/endpoint-service.ts"
import type { ModelConfig, Settings } from "../../src/core/domain/model.ts"
import { FakeCatalog } from "./catalog.ts"
import { FakeClock } from "./clock.ts"
import { FakeCompute } from "./compute.ts"
import { ScriptedConfirmation } from "./confirmation.ts"
import { RecordingLogger } from "./logger.ts"
import { RecordingNotifier } from "./notifier.ts"
import { FakeRecipe } from "./recipe.ts"
import { InMemoryStateStore } from "./store.ts"
import { FakeWeights } from "./weights.ts"

export function sampleModel(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: "m",
    name: "Model M",
    hf: "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8",
    gpu: "AMPERE_48",
    gpuCount: 1,
    context: 65536,
    output: 8192,
    tools: true,
    family: null,
    toolParser: undefined,
    reasoningParser: undefined,
    quantization: "fp8",
    weightsGb: null,
    env: {},
    ...overrides,
  }
}

export function sampleSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    confirm: true,
    confirmTimeoutSec: 120,
    idleTimeout: 120,
    workersMax: 1,
    executionTimeoutSec: 600,
    coldStartTimeoutSec: 600,
    deleteOnExit: true,
    adoptExisting: true,
    maxHourlyRate: null,
    dataCenterIds: [],
    minCudaVersion: "12.8",
    workerImage: "runpod/worker-v1-vllm:v2.27.2",
    flashboot: true,
    models: [sampleModel()],
    ...overrides,
  }
}

export interface Harness {
  clock: FakeClock
  compute: FakeCompute
  catalog: FakeCatalog
  weights: FakeWeights
  recipe: FakeRecipe
  store: InMemoryStateStore
  confirmation: ScriptedConfirmation
  notifier: RecordingNotifier
  logger: RecordingLogger
  settings: Settings
  service: EndpointService
}

export function harness(
  settingsOverrides: Partial<Settings> = {},
  opts: { answers?: boolean[]; weights?: number | null; compute?: boolean } = {},
): Harness {
  const settings = sampleSettings(settingsOverrides)
  const clock = new FakeClock()
  const compute = new FakeCompute()
  const catalog = new FakeCatalog()
  const weights = new FakeWeights(opts.weights === undefined ? 31.6 : opts.weights)
  const recipe = new FakeRecipe()
  const store = new InMemoryStateStore()
  const confirmation = new ScriptedConfirmation(opts.answers ?? [true])
  const notifier = new RecordingNotifier()
  const logger = new RecordingLogger()
  const ports: ServicePorts = {
    compute: opts.compute === false ? null : compute,
    catalog,
    weights,
    recipe,
    store,
    clock,
    confirmation,
    notifier,
    logger,
  }
  return { clock, compute, catalog, weights, recipe, store, confirmation, notifier, logger, settings, service: new EndpointService(settings, ports) }
}
```

- [ ] **Step 3: Write the failing test**

`test/service-ensure-ready.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import type { EndpointRecord } from "../src/core/domain/endpoint.ts"
import { flush } from "./fakes/clock.ts"
import { harness } from "./fakes/fixtures.ts"

test("happy path: quote → confirm → create → warm → ready, returns the inference URL", async () => {
  const h = harness()
  const pending = h.service.ensureReady("m")
  await flush()
  assert.equal(h.service.phase("m"), "warming")
  assert.equal(h.confirmation.asked.length, 1)
  const quote = h.confirmation.asked[0]!
  assert.equal(quote.gpuLabel, "A6000/A40 48GB")
  assert.equal(quote.ratePerHour, 1.22)
  assert.equal(quote.rateSource, "catalog")
  assert.equal(quote.weightsGb, 31.6)
  assert.equal(h.compute.created.length, 1)
  const spec = h.compute.created[0]!
  assert.equal(spec.name, "oc-runpod-m")
  assert.equal(spec.gpu.pool, "AMPERE_48")
  assert.deepEqual(spec.workers, { min: 0, max: 1, idleTimeoutSec: 120 })
  assert.equal(spec.recipe.env.MODEL_NAME, "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8")
  assert.equal(spec.recipe.diskGb, 42)
  h.compute.finishWarmup()
  await flush()
  assert.equal(await pending, "https://compute.test/ep1/v1")
  assert.equal(h.service.phase("m"), "ready")
  assert.deepEqual(h.notifier.phases, ["confirming", "creating", "warming", "ready"])
  const ready = h.notifier.events.at(-1)!
  assert.equal(ready.ratePerHour, 1.22)
  assert.equal(ready.gpuLabel, "A6000/A40 48GB")
  const record = await h.store.get<EndpointRecord>("endpoints/m")
  assert.equal(record?.endpointID, "ep1")
  assert.equal(record?.hash, spec.hash)
  assert.equal(record?.modelID, "m")
  assert.equal(await h.store.get("weights/Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8"), 31.6)
})

test("declined confirmation: nothing created, phase back to cold, actionable error", async () => {
  const h = harness({}, { answers: [false] })
  await assert.rejects(h.service.ensureReady("m"), /declined or not confirmed within 120s.*\/runpod-up m.*options\.confirm=false/s)
  assert.equal(h.compute.created.length, 0)
  assert.equal(h.service.phase("m"), "cold")
  assert.deepEqual(h.notifier.phases, ["confirming", "cold"])
})

test("blocked quote (maxHourlyRate) refuses before asking", async () => {
  const h = harness({ maxHourlyRate: 1.0 })
  await assert.rejects(h.service.ensureReady("m"), /refusing to provision m: \$1\.22\/h exceeds options\.maxHourlyRate \$1\.00/)
  assert.equal(h.confirmation.asked.length, 0)
  assert.equal(h.compute.created.length, 0)
})

test("confirm=false and skipConfirm both bypass the dialog", async () => {
  const a = harness({ confirm: false })
  const pa = a.service.ensureReady("m")
  await flush()
  a.compute.finishWarmup()
  await pa
  assert.equal(a.confirmation.asked.length, 0)
  const b = harness()
  const pb = b.service.ensureReady("m", { skipConfirm: true })
  await flush()
  b.compute.finishWarmup()
  await pb
  assert.equal(b.confirmation.asked.length, 0)
})

test("concurrent callers share one in-flight provisioning", async () => {
  const h = harness()
  const p1 = h.service.ensureReady("m")
  const p2 = h.service.ensureReady("m")
  await flush()
  h.compute.finishWarmup()
  const [u1, u2] = await Promise.all([p1, p2])
  assert.equal(u1, u2)
  assert.equal(h.compute.created.length, 1)
  assert.equal(h.compute.calls.filter((c) => c.startsWith("warmup:")).length, 1)
})

test("ready model is returned immediately without new compute calls", async () => {
  const h = harness()
  const p = h.service.ensureReady("m")
  await flush()
  h.compute.finishWarmup()
  await p
  const calls = h.compute.calls.length
  assert.equal(await h.service.ensureReady("m"), "https://compute.test/ep1/v1")
  assert.equal(h.compute.calls.length, calls)
})

test("unknown model and missing compute provider are actionable errors", async () => {
  const h = harness()
  await assert.rejects(h.service.ensureReady("nope"), /model "nope" is not configured/)
  const noKey = harness({}, { compute: false })
  await assert.rejects(noKey.service.ensureReady("m"), /API key/)
})

test("weights size is read from the store cache before asking the weights port", async () => {
  const h = harness()
  await h.store.set("weights/Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8", 12)
  const p = h.service.ensureReady("m")
  await flush()
  h.compute.finishWarmup()
  await p
  assert.equal(h.weights.calls, 0)
  assert.equal(h.confirmation.asked[0]!.weightsGb, 12)
})

test("catalog failure leaves the price unknown and provisioning is refused", async () => {
  const h = harness()
  h.catalog.fail = true
  await assert.rejects(h.service.ensureReady("m"), /no price known for GPU pool "AMPERE_48"/)
  assert.equal(h.compute.created.length, 0)
})

test("create failure resets to cold and propagates", async () => {
  const h = harness()
  h.compute.failCreate = new Error("quota exceeded")
  await assert.rejects(h.service.ensureReady("m"), /quota exceeded/)
  assert.equal(h.service.phase("m"), "cold")
  assert.equal(await h.store.get("endpoints/m"), undefined)
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find `src/core/application/endpoint-service.ts`.

- [ ] **Step 5: Implement `src/core/application/endpoint-service.ts`** (and `git rm src/core/application/.gitkeep`)

```ts
import { buildEndpointSpec, type EndpointRecord, type Phase } from "../domain/endpoint.ts"
import type { StateEvent } from "../domain/events.ts"
import type { ModelConfig, Settings } from "../domain/model.ts"
import { DEFAULT_WEIGHTS_GB, buildQuote, type PoolRate, type Quote } from "../domain/quote.ts"
import { SpendMeter } from "../domain/spend-meter.ts"
import type { ClockPort } from "../ports/clock.ts"
import { ComputeError, type ComputeProviderPort } from "../ports/compute-provider.ts"
import type { ConfirmationPort } from "../ports/confirmation.ts"
import type { ModelRoutingPort } from "../ports/driving.ts"
import type { LoggerPort } from "../ports/logger.ts"
import type { NotifierPort } from "../ports/notifier.ts"
import type { PriceCatalogPort } from "../ports/price-catalog.ts"
import type { StateStorePort } from "../ports/state-store.ts"
import type { WeightsInfoPort } from "../ports/weights-info.ts"
import type { WorkerRecipePort } from "../ports/worker-recipe.ts"

/** Extra time after the provider's idle timeout before we assume the worker scaled to zero. */
export const IDLE_GRACE_MS = 15_000
export const HEALTH_POLL_MS = 3_000
export const WARMUP_RETRY_MS = 5_000

export interface ServicePorts {
  compute: ComputeProviderPort | null
  catalog: PriceCatalogPort
  weights: WeightsInfoPort
  recipe: WorkerRecipePort
  store: StateStorePort
  clock: ClockPort
  confirmation: ConfirmationPort
  notifier: NotifierPort
  logger: LoggerPort
}

interface ModelState {
  model: ModelConfig
  phase: Phase
  detail: string | null
  record: EndpointRecord | null
  inflight: Promise<string> | null
  lastRequestAt: number | null
  idleTimer: unknown
  meter: SpendMeter
  rate: PoolRate | null
}

const round = (n: number) => Math.round(n * 1000) / 1000
export const recordKey = (modelID: string) => `endpoints/${modelID}`
export const weightsKey = (hf: string) => `weights/${hf}`

export class EndpointService implements ModelRoutingPort {
  protected readonly settings: Settings
  protected readonly ports: ServicePorts
  protected readonly states = new Map<string, ModelState>()

  constructor(settings: Settings, ports: ServicePorts) {
    this.settings = settings
    this.ports = ports
    for (const model of settings.models) {
      this.states.set(model.id, {
        model,
        phase: "cold",
        detail: null,
        record: null,
        inflight: null,
        lastRequestAt: null,
        idleTimer: null,
        meter: new SpendMeter(() => ports.clock.now()),
        rate: null,
      })
    }
  }

  phase(modelID: string): Phase {
    return this.state(modelID).phase
  }

  async ensureReady(modelID: string, opts: { skipConfirm?: boolean } = {}): Promise<string> {
    const st = this.state(modelID)
    if (st.inflight) return st.inflight
    const run = this.run(st, opts).finally(() => {
      st.inflight = null
    })
    st.inflight = run
    return run
  }

  // ---- internals -------------------------------------------------------

  protected state(modelID: string): ModelState {
    const st = this.states.get(modelID)
    if (!st) throw new Error(`RunPod: model "${modelID}" is not configured (options.models)`)
    return st
  }

  protected compute(): ComputeProviderPort {
    if (!this.ports.compute) {
      throw new Error("RunPod: no API key configured — set options.apiKey or the RUNPOD_API_KEY environment variable.")
    }
    return this.ports.compute
  }

  private async run(st: ModelState, opts: { skipConfirm?: boolean }): Promise<string> {
    const compute = this.compute()
    if (!st.record) {
      const quote = await this.quote(st)
      if (quote.blocked) throw new Error(`RunPod: refusing to provision ${st.model.id}: ${quote.blocked}`)
      if (this.settings.confirm && !opts.skipConfirm) {
        this.setPhase(st, "confirming", `waiting for confirmation · ${quote.gpuLabel} · $${quote.ratePerHour.toFixed(2)}/h`)
        const accepted = await this.ports.confirmation.ask(quote)
        if (!accepted) {
          this.setPhase(st, "cold", "provisioning declined")
          throw new Error(
            `RunPod: provisioning of ${st.model.id} was declined or not confirmed within ${this.settings.confirmTimeoutSec}s. ` +
              `Run /runpod-up ${st.model.id} to provision without the dialog, or set options.confirm=false.`,
          )
        }
      }
      await this.create(st, quote, compute)
    }
    if (st.phase !== "ready") await this.warm(st, compute)
    this.touch(st)
    return compute.inferenceBaseURL(st.record!.endpointID)
  }

  protected async rateFor(st: ModelState): Promise<PoolRate> {
    try {
      st.rate = await this.ports.catalog.rate(st.model.gpu)
    } catch (error) {
      this.ports.logger.warn("price lookup failed", { pool: st.model.gpu, error: String(error) })
      if (!st.rate) st.rate = { ratePerHour: 0, source: "fallback", vramGb: null, label: st.model.gpu }
    }
    return st.rate
  }

  private async quote(st: ModelState): Promise<Quote> {
    const rate = await this.rateFor(st)
    const weightsGb = st.model.weightsGb ?? (await this.weightsGb(st.model))
    return buildQuote({ model: st.model, settings: this.settings, rate, weightsGb })
  }

  private async weightsGb(model: ModelConfig): Promise<number | null> {
    const cached = await this.ports.store.get<number>(weightsKey(model.hf))
    if (typeof cached === "number") return cached
    let size: number | null = null
    try {
      size = await this.ports.weights.weightsGb(model)
    } catch (error) {
      this.ports.logger.warn("weights lookup failed", { hf: model.hf, error: String(error) })
    }
    if (size !== null) await this.ports.store.set(weightsKey(model.hf), size)
    return size
  }

  private async create(st: ModelState, quote: Quote, compute: ComputeProviderPort): Promise<void> {
    this.setPhase(st, "creating", `creating endpoint on ${quote.gpuLabel}`)
    const recipe = this.ports.recipe.recipe(st.model, this.settings, quote.weightsGb ?? DEFAULT_WEIGHTS_GB)
    const spec = buildEndpointSpec(st.model, this.settings, recipe)
    let created: { id: string }
    try {
      created = await compute.create(spec)
    } catch (error) {
      this.setPhase(st, "cold", `create failed: ${(error as Error).message}`)
      throw error
    }
    st.record = {
      endpointID: created.id,
      name: spec.name,
      modelID: st.model.id,
      gpu: st.model.gpu,
      gpuCount: st.model.gpuCount,
      hash: spec.hash,
      createdAt: this.ports.clock.now(),
      spendUsd: 0,
    }
    await this.ports.store.set(recordKey(st.model.id), st.record)
    this.ports.logger.info("endpoint created", { modelID: st.model.id, endpointID: created.id })
  }

  private async warm(st: ModelState, compute: ComputeProviderPort): Promise<void> {
    const record = st.record!
    const clock = this.ports.clock
    const started = clock.now()
    st.meter.start(this.hourly(st), started)
    this.setPhase(st, "warming", "starting worker", 0)
    const controller = new AbortController()
    const deadline = clock.setTimer(() => controller.abort(), this.settings.coldStartTimeoutSec * 1000)
    void this.pollHealth(st, record.endpointID, controller.signal, started, compute)
    let lastError: unknown = null
    try {
      while (!controller.signal.aborted) {
        try {
          await compute.warmup(record.endpointID, st.model.id, controller.signal)
          const elapsed = this.elapsed(started)
          this.setPhase(st, "ready", `ready in ${elapsed}s`, elapsed)
          return
        } catch (error) {
          if (controller.signal.aborted) break
          lastError = error
          if (error instanceof ComputeError && error.kind === "fatal") break
          this.ports.logger.warn("warm-up attempt failed, retrying", { modelID: st.model.id, error: String(error) })
          await clock.sleep(WARMUP_RETRY_MS)
        }
      }
      st.meter.stop(clock.now())
      const elapsed = this.elapsed(started)
      const reason = controller.signal.aborted
        ? `timed out after ${elapsed}s`
        : `failed after ${elapsed}s: ${(lastError as Error | null)?.message ?? "unknown error"}`
      const diagnostics = await compute.diagnostics(record.endpointID).catch(() => null)
      this.setPhase(st, "cold", `cold start ${reason}`)
      throw new Error(
        `RunPod: cold start of ${st.model.id} ${reason}. Endpoint ${record.endpointID} was kept; retry, or run /runpod-down ${st.model.id}.` +
          (diagnostics ? `\nWorker log tail:\n${diagnostics}` : ""),
      )
    } finally {
      clock.clearTimer(deadline)
      controller.abort()
    }
  }

  private async pollHealth(st: ModelState, endpointID: string, signal: AbortSignal, started: number, compute: ComputeProviderPort): Promise<void> {
    while (!signal.aborted) {
      await this.ports.clock.sleep(HEALTH_POLL_MS)
      if (signal.aborted || st.phase !== "warming") return
      try {
        const h = await compute.health(endpointID)
        this.setPhase(st, "warming", `workers: initializing ${h.initializing} · running ${h.running} · idle ${h.idle} · throttled ${h.throttled}`, this.elapsed(started))
      } catch (error) {
        this.ports.logger.warn("health poll failed", { endpointID, error: String(error) })
      }
    }
  }

  protected touch(st: ModelState): void {
    st.lastRequestAt = this.ports.clock.now()
    if (st.idleTimer !== null) this.ports.clock.clearTimer(st.idleTimer)
    st.idleTimer = this.ports.clock.setTimer(() => this.onIdle(st), this.settings.idleTimeout * 1000 + IDLE_GRACE_MS)
  }

  private onIdle(st: ModelState): void {
    st.idleTimer = null
    if (st.phase !== "ready" || st.lastRequestAt === null) return
    st.meter.stop(st.lastRequestAt + this.settings.idleTimeout * 1000)
    this.setPhase(st, "idle", "worker scaled to zero")
    if (st.record) {
      st.record.spendUsd = round(st.meter.usd())
      void this.ports.store.set(recordKey(st.model.id), st.record)
    }
  }

  protected setPhase(st: ModelState, phase: Phase, detail: string | null, elapsedSec: number | null = null): void {
    st.phase = phase
    st.detail = detail
    const event: StateEvent = {
      modelID: st.model.id,
      phase,
      detail,
      elapsedSec,
      spendUsd: round(st.meter.usd()),
      ratePerHour: this.hourly(st),
      gpu: st.model.gpu,
      gpuLabel: st.rate?.label ?? st.model.gpu,
    }
    this.ports.notifier.state(event)
    this.ports.logger.info(`${st.model.id}: ${phase}${detail ? ` · ${detail}` : ""}`)
  }

  protected hourly(st: ModelState): number {
    return Math.round((st.rate?.ratePerHour ?? 0) * st.model.gpuCount * 1e4) / 1e4
  }

  protected elapsed(started: number): number {
    return Math.round((this.ports.clock.now() - started) / 1000)
  }
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npm run check`
Expected: all tests pass (architecture test included — the service imports only core), tsc clean.

- [ ] **Step 7: Commit**

```bash
git rm -q src/core/application/.gitkeep
git add src/core/ports src/core/application test/fakes test/service-ensure-ready.test.ts
git commit -m "feat(core): ports and EndpointService provisioning path with test fakes"
```

---

### Task 4: Warm-up robustness and idle handling (characterization tests)

**Files:**
- Test: `test/service-warmup.test.ts`
- Modify (only if a test fails): `src/core/application/endpoint-service.ts`

**Interfaces:**
- Consumes: `EndpointService`, fakes, `ComputeError`, `IDLE_GRACE_MS`, `HEALTH_POLL_MS`, `WARMUP_RETRY_MS`.

- [ ] **Step 1: Write the tests**

`test/service-warmup.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { HEALTH_POLL_MS, IDLE_GRACE_MS, WARMUP_RETRY_MS } from "../src/core/application/endpoint-service.ts"
import { ComputeError } from "../src/core/ports/compute-provider.ts"
import { flush } from "./fakes/clock.ts"
import { harness } from "./fakes/fixtures.ts"

/** Returns the in-flight promise wrapped in an object so the async helper does not adopt (and wait for) it. */
async function startWarming(h: ReturnType<typeof harness>) {
  const pending = h.service.ensureReady("m")
  await flush()
  assert.equal(h.service.phase("m"), "warming")
  return { pending }
}

test("health polling emits progress with elapsed seconds while warming", async () => {
  const h = harness()
  const { pending } = await startWarming(h)
  h.compute.healthSnapshot = { initializing: 1, running: 0, idle: 0, throttled: 0 }
  await h.clock.advance(HEALTH_POLL_MS)
  const progress = h.notifier.events.at(-1)!
  assert.equal(progress.phase, "warming")
  assert.match(progress.detail ?? "", /initializing 1 · running 0/)
  assert.equal(progress.elapsedSec, 3)
  h.compute.finishWarmup()
  await pending
  const ready = h.notifier.events.at(-1)!
  assert.equal(ready.phase, "ready")
  assert.equal(ready.elapsedSec, 3)
  assert.match(ready.detail ?? "", /ready in 3s/)
  await h.clock.advance(HEALTH_POLL_MS) // poller exits quietly after abort
  assert.equal(h.notifier.events.at(-1)!.phase, "ready")
})

test("transient warm-up errors are retried after WARMUP_RETRY_MS", async () => {
  const h = harness()
  const { pending } = await startWarming(h)
  h.compute.failWarmup(new ComputeError("502 Bad Gateway", "transient", 502))
  await flush()
  assert.equal(h.compute.pendingWarmups, 0)
  await h.clock.advance(WARMUP_RETRY_MS)
  assert.equal(h.compute.pendingWarmups, 1)
  h.compute.finishWarmup()
  await pending
  assert.equal(h.compute.calls.filter((c) => c.startsWith("warmup:")).length, 2)
  assert.equal(h.service.phase("m"), "ready")
})

test("fatal warm-up errors stop immediately, keep the endpoint and stop the meter", async () => {
  const h = harness()
  const { pending } = await startWarming(h)
  h.compute.failWarmup(new ComputeError("RunPod 400 Bad Request: model not found", "fatal", 400))
  await assert.rejects(pending, /cold start of m failed after 0s: RunPod 400 Bad Request: model not found.*Endpoint ep1 was kept/s)
  assert.equal(h.service.phase("m"), "cold")
  assert.equal(h.compute.calls.filter((c) => c.startsWith("delete:")).length, 0)
  assert.equal(h.notifier.events.at(-1)!.spendUsd, 0)
  assert.equal(await h.store.get("endpoints/m") !== undefined, true)
})

test("cold start timeout aborts, includes worker diagnostics, and a retry re-warms without re-confirming", async () => {
  const h = harness({ coldStartTimeoutSec: 60 })
  h.compute.diagnosticsText = "CUDA out of memory\nworker exited"
  const { pending } = await startWarming(h)
  await h.clock.advance(60_000)
  await assert.rejects(pending, /timed out after 60s.*Worker log tail:\nCUDA out of memory\nworker exited/s)
  assert.equal(h.service.phase("m"), "cold")
  const retry = h.service.ensureReady("m")
  await flush()
  assert.equal(h.confirmation.asked.length, 1) // no second dialog
  assert.equal(h.compute.created.length, 1) // no second endpoint
  h.compute.finishWarmup()
  assert.equal(await retry, "https://compute.test/ep1/v1")
})

test("idle detection stops the meter at lastRequest + idleTimeout and the next request re-warms", async () => {
  const h = harness()
  const { pending } = await startWarming(h)
  await h.clock.advance(3_000)
  h.compute.finishWarmup()
  await pending
  // ready at t=3s; meter running at $1.22/h since t=0
  await h.clock.advance(120_000 + IDLE_GRACE_MS)
  assert.equal(h.service.phase("m"), "idle")
  const idle = h.notifier.events.at(-1)!
  assert.equal(idle.phase, "idle")
  const expected = (1.22 * (3_000 + 120_000)) / 3_600_000
  assert.ok(Math.abs(idle.spendUsd - Math.round(expected * 1000) / 1000) < 1e-9, `spend ${idle.spendUsd}`)
  const stored = await h.store.get<{ spendUsd: number }>("endpoints/m")
  assert.equal(stored?.spendUsd, idle.spendUsd)
  const again = h.service.ensureReady("m")
  await flush()
  assert.equal(h.service.phase("m"), "warming")
  assert.equal(h.confirmation.asked.length, 1)
  assert.equal(h.compute.created.length, 1)
  h.compute.finishWarmup()
  await again
  assert.equal(h.service.phase("m"), "ready")
})

test("requests during the idle window keep the worker counted as warm", async () => {
  const h = harness()
  const { pending } = await startWarming(h)
  h.compute.finishWarmup()
  await pending
  await h.clock.advance(100_000)
  await h.service.ensureReady("m") // touches lastRequestAt at t=100s
  await h.clock.advance(100_000) // t=200s: only 100s since last request → still ready
  assert.equal(h.service.phase("m"), "ready")
  await h.clock.advance(20_000 + IDLE_GRACE_MS)
  assert.equal(h.service.phase("m"), "idle")
})
```

- [ ] **Step 2: Run the tests**

Run: `npm test`
Expected: all pass. If one fails, fix `endpoint-service.ts` so that the behaviour matches the test (the tests encode the spec), re-run, and describe the fix in the commit body.

- [ ] **Step 3: Commit**

```bash
git add test/service-warmup.test.ts src/core/application/endpoint-service.ts
git commit -m "test(core): characterize warm-up retries, timeouts, diagnostics and idle re-warm"
```

---

### Task 5: Lifecycle and operations — `start`, `down`, `stop`, `status`

**Files:**
- Modify: `src/core/application/endpoint-service.ts`
- Test: `test/service-lifecycle.test.ts`

**Interfaces:**
- Produces: `EndpointService implements ModelRoutingPort, OperationsPort, LifecyclePort` — `start(): Promise<void>` (reconcile), `stop(budgetMs = 10000)`, `status(): Promise<StatusReport>`, `up(modelID)`, `down(modelID?)`.

- [ ] **Step 1: Write the failing test**

`test/service-lifecycle.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { specHashFor, type EndpointRecord } from "../src/core/domain/endpoint.ts"
import { flush } from "./fakes/clock.ts"
import { harness, sampleModel } from "./fakes/fixtures.ts"

function expectedHash(h: ReturnType<typeof harness>) {
  const model = h.settings.models[0]!
  return specHashFor(model, h.settings, h.recipe.recipe(model, h.settings, null))
}

async function warm(h: ReturnType<typeof harness>) {
  const p = h.service.ensureReady("m")
  await flush()
  h.compute.finishWarmup()
  await p
}

test("start adopts a matching remote endpoint, stores a record and reports idle", async () => {
  const h = harness()
  h.compute.remote.push({ id: "epX", name: "oc-runpod-m", hash: expectedHash(h) })
  await h.service.start()
  assert.equal(h.service.phase("m"), "idle")
  const record = await h.store.get<EndpointRecord>("endpoints/m")
  assert.equal(record?.endpointID, "epX")
  assert.equal(record?.hash, expectedHash(h))
  assert.deepEqual(h.notifier.phases, ["idle"])
  assert.equal(h.compute.calls.filter((c) => c.startsWith("delete:")).length, 0)
  const p = h.service.ensureReady("m") // adopted → warm without confirm or create
  await flush()
  assert.equal(h.confirmation.asked.length, 0)
  assert.equal(h.compute.created.length, 0)
  h.compute.finishWarmup()
  assert.equal(await p, "https://compute.test/epX/v1")
})

test("start deletes stale endpoints (hash mismatch, unknown model, duplicates) when deleteOnExit", async () => {
  const h = harness()
  h.compute.remote.push({ id: "old", name: "oc-runpod-m", hash: "0000000000000000" })
  h.compute.remote.push({ id: "gone", name: "oc-runpod-removed-model", hash: expectedHash(h) })
  h.compute.remote.push({ id: "keep", name: "oc-runpod-m", hash: expectedHash(h) })
  h.compute.remote.push({ id: "dup", name: "oc-runpod-m", hash: expectedHash(h) })
  h.compute.remote.push({ id: "unrelated", name: "someone-elses-endpoint", hash: null })
  await h.service.start()
  const deleted = h.compute.calls.filter((c) => c.startsWith("delete:")).map((c) => c.slice(7)).sort()
  assert.deepEqual(deleted, ["dup", "gone", "old"])
  assert.equal((await h.store.get<EndpointRecord>("endpoints/m"))?.endpointID, "keep")
  const status = await h.service.status()
  assert.deepEqual(status.orphans, [])
})

test("start keeps stale endpoints as orphans when deleteOnExit is false or adoptExisting is false", async () => {
  const h = harness({ deleteOnExit: false, adoptExisting: false })
  h.compute.remote.push({ id: "epX", name: "oc-runpod-m", hash: expectedHash(h) })
  await h.service.start()
  assert.equal(h.service.phase("m"), "cold")
  assert.equal(h.compute.calls.filter((c) => c.startsWith("delete:")).length, 0)
  const status = await h.service.status()
  assert.deepEqual(status.orphans, [{ id: "epX", name: "oc-runpod-m" }])
})

test("start restores a stored record when its endpoint still exists and drops it otherwise", async () => {
  const kept = harness()
  await kept.store.set("endpoints/m", { endpointID: "epS", name: "oc-runpod-m", modelID: "m", gpu: "AMPERE_48", gpuCount: 1, hash: expectedHash(kept), createdAt: 1, spendUsd: 0.5 })
  kept.compute.remote.push({ id: "epS", name: "oc-runpod-m", hash: expectedHash(kept) })
  await kept.service.start()
  assert.equal(kept.service.phase("m"), "idle")
  assert.equal((await kept.service.status()).models[0]!.endpointID, "epS")

  const vanished = harness()
  await vanished.store.set("endpoints/m", { endpointID: "epV", name: "oc-runpod-m", modelID: "m", gpu: "AMPERE_48", gpuCount: 1, hash: expectedHash(vanished), createdAt: 1, spendUsd: 0 })
  await vanished.service.start()
  assert.equal(await vanished.store.get("endpoints/m"), undefined)
  assert.equal(vanished.service.phase("m"), "cold")
})

test("start is a no-op without a compute provider", async () => {
  const h = harness({}, { compute: false })
  await h.service.start()
  assert.equal(h.compute.calls.length, 0)
})

test("down scales to zero, deletes, clears storage and reports spend", async () => {
  const h = harness()
  await warm(h)
  await h.clock.advance(30_000)
  const deleted = await h.service.down("m")
  assert.deepEqual(deleted, ["m"])
  assert.deepEqual(h.compute.calls.filter((c) => /^(scaleToZero|delete):/.test(c)), ["scaleToZero:ep1", "delete:ep1"])
  assert.equal(await h.store.get("endpoints/m"), undefined)
  assert.equal(h.service.phase("m"), "cold")
  const last = h.notifier.events.at(-1)!
  assert.match(last.detail ?? "", /deleted · ≈\$0\.01 this session/)
  assert.deepEqual(await h.service.down(), [])
  assert.deepEqual(h.notifier.phases.slice(-2), ["deleting", "cold"])
})

test("down without a model id deletes every owned endpoint; delete failures surface", async () => {
  const two = harness({ models: [sampleModel(), sampleModel({ id: "n", hf: "Qwen/Qwen3-8B", gpu: "AMPERE_16" })] })
  for (const id of ["m", "n"]) {
    const p = two.service.ensureReady(id)
    await flush()
    two.compute.finishWarmup()
    await p
  }
  assert.deepEqual(await two.service.down(), ["m", "n"])
  const failing = harness()
  await warm(failing)
  failing.compute.failDelete = new Error("forbidden")
  await assert.rejects(failing.service.down("m"), /forbidden/)
  assert.equal(failing.service.phase("m"), "error")
})

test("stop deletes owned endpoints only when deleteOnExit is set", async () => {
  const on = harness()
  await warm(on)
  await on.service.stop(10_000)
  assert.ok(on.compute.calls.includes("delete:ep1"))
  const off = harness({ deleteOnExit: false })
  await warm(off)
  await off.service.stop(10_000)
  assert.equal(off.compute.calls.filter((c) => c.startsWith("delete:")).length, 0)
})

test("status reports phase, endpoint, rate, spend, billed and orphans; up() skips confirmation", async () => {
  const h = harness()
  h.compute.billed = 0.77
  const before = await h.service.status()
  assert.equal(before.models.length, 1)
  assert.equal(before.models[0]!.phase, "cold")
  assert.equal(before.models[0]!.endpointID, null)
  assert.equal(before.models[0]!.ratePerHour, 1.22)
  assert.equal(before.models[0]!.gpuLabel, "A6000/A40 48GB")
  assert.equal(before.models[0]!.billedUsd, null)
  const p = h.service.up("m")
  await flush()
  assert.equal(h.confirmation.asked.length, 0)
  h.compute.finishWarmup()
  await p
  await h.clock.advance(60_000)
  const after = await h.service.status()
  const m = after.models[0]!
  assert.equal(m.phase, "ready")
  assert.equal(m.endpointID, "ep1")
  assert.equal(m.billedUsd, 0.77)
  assert.ok(m.spendUsd > 0)
  assert.equal(m.lastRequestAt, 0)
  assert.equal(m.gpuCount, 1)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `start`, `down`, `stop`, `status`, `up` are not functions.

- [ ] **Step 3: Add the lifecycle and operations methods to `EndpointService`**

Change the class declaration and imports:
```ts
import { buildEndpointSpec, modelIDFromName, specHashFor, type EndpointRecord, type Phase } from "../domain/endpoint.ts"
import type { ModelStatus, StateEvent, StatusReport } from "../domain/events.ts"
import type { LifecyclePort, ModelRoutingPort, OperationsPort } from "../ports/driving.ts"
// ...
export class EndpointService implements ModelRoutingPort, OperationsPort, LifecyclePort {
  private orphans: { id: string; name: string }[] = []
```
Add these methods after `ensureReady`:
```ts
  up(modelID: string): Promise<string> {
    return this.ensureReady(modelID, { skipConfirm: true })
  }

  /** Reconcile remote endpoints with configuration: restore or adopt matching ones, remove stale ones. */
  async start(): Promise<void> {
    const compute = this.ports.compute
    if (!compute) return
    this.orphans = []
    const remote = await compute.list()
    const byId = new Map(remote.map((ep) => [ep.id, ep] as const))
    for (const st of this.states.values()) {
      const stored = await this.ports.store.get<EndpointRecord>(recordKey(st.model.id))
      if (!stored) continue
      const ep = byId.get(stored.endpointID)
      if (ep && ep.hash === this.expectedHash(st.model)) {
        st.record = stored
        await this.rateFor(st)
        this.setPhase(st, "idle", "restored endpoint from storage")
      } else {
        await this.ports.store.remove(recordKey(st.model.id))
      }
    }
    for (const ep of remote) {
      const modelID = modelIDFromName(ep.name)
      if (modelID === null) continue
      const st = this.states.get(modelID)
      if (st?.record?.endpointID === ep.id) continue
      if (st && !st.record && this.settings.adoptExisting && ep.hash !== null && ep.hash === this.expectedHash(st.model)) {
        st.record = { endpointID: ep.id, name: ep.name, modelID, gpu: st.model.gpu, gpuCount: st.model.gpuCount, hash: ep.hash, createdAt: this.ports.clock.now(), spendUsd: 0 }
        await this.ports.store.set(recordKey(modelID), st.record)
        await this.rateFor(st)
        this.setPhase(st, "idle", "adopted existing endpoint")
        continue
      }
      if (this.settings.deleteOnExit) {
        try {
          await compute.delete(ep.id)
          this.ports.logger.info("deleted stale endpoint", { id: ep.id, name: ep.name })
          continue
        } catch (error) {
          this.ports.logger.warn("failed to delete stale endpoint", { id: ep.id, error: String(error) })
        }
      }
      this.orphans.push({ id: ep.id, name: ep.name })
    }
  }

  /** Best-effort teardown within a time budget; used at plugin shutdown. */
  async stop(budgetMs = 10_000): Promise<void> {
    if (!this.settings.deleteOnExit) return
    await Promise.race([
      this.down().catch((error: unknown) => {
        this.ports.logger.warn("shutdown cleanup failed", { error: String(error) })
      }),
      this.ports.clock.sleep(budgetMs),
    ])
  }

  async down(modelID?: string): Promise<string[]> {
    const compute = this.compute()
    const targets = modelID === undefined ? [...this.states.values()] : [this.state(modelID)]
    const deleted: string[] = []
    for (const st of targets) {
      const record = st.record
      if (!record) continue
      this.setPhase(st, "deleting", `deleting ${record.endpointID}`)
      try {
        await compute.scaleToZero(record.endpointID)
      } catch (error) {
        this.ports.logger.warn("scale-to-zero before delete failed", { error: String(error) })
      }
      try {
        await compute.delete(record.endpointID)
      } catch (error) {
        this.setPhase(st, "error", `delete failed: ${(error as Error).message}`)
        throw error
      }
      if (st.idleTimer !== null) {
        this.ports.clock.clearTimer(st.idleTimer)
        st.idleTimer = null
      }
      st.meter.stop(this.ports.clock.now())
      st.record = null
      await this.ports.store.remove(recordKey(st.model.id))
      this.setPhase(st, "cold", `deleted · ≈$${st.meter.usd().toFixed(2)} this session`)
      deleted.push(st.model.id)
    }
    return deleted
  }

  async status(): Promise<StatusReport> {
    const models: ModelStatus[] = []
    for (const st of this.states.values()) {
      const rate = await this.rateFor(st)
      let billedUsd: number | null = null
      if (st.record && this.ports.compute) billedUsd = await this.ports.compute.billedUsd(st.record.endpointID).catch(() => null)
      models.push({
        modelID: st.model.id,
        phase: st.phase,
        detail: st.detail,
        spendUsd: round(st.meter.usd()),
        ratePerHour: this.hourly(st),
        gpu: st.model.gpu,
        gpuLabel: rate.label,
        endpointID: st.record?.endpointID ?? null,
        gpuCount: st.model.gpuCount,
        billedUsd,
        lastRequestAt: st.lastRequestAt,
      })
    }
    return { models, orphans: [...this.orphans] }
  }

  private expectedHash(model: ModelConfig): string {
    return specHashFor(model, this.settings, this.ports.recipe.recipe(model, this.settings, null))
  }
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm run check`
Expected: pass. (`expectedHash` matches the test helper because both call the recipe with `weightsGb = null` and hash excludes disk.)

- [ ] **Step 5: Commit**

```bash
git add src/core/application/endpoint-service.ts test/service-lifecycle.test.ts
git commit -m "feat(core): reconcile on start, teardown, shutdown budget and status reporting"
```

---

### Task 6: RunPod REST v2 HTTP client (driven adapter, transport layer)

**Files:**
- Create: `src/adapters/driven/runpod/types.ts`, `src/adapters/driven/runpod/http.ts`
- Test: `test/runpod-http.test.ts`

**Interfaces:**
- Produces (types): `CreateEndpointRequest`, `EndpointPatch`, `EndpointInfo`, `WorkerInfo`, `HealthInfo`, `GpuCatalogEntry`.
- Produces: `class RunpodError extends Error { status; title; detail }`, `interface RunpodClientOptions { apiKey; fetch?; sleep?; apiBase?; runtimeBase?; maxRetries? }`, `class RunpodHttp` with `listEndpoints()`, `createEndpoint(body)`, `getEndpoint(id)`, `patchEndpoint(id, patch)`, `deleteEndpoint(id)`, `listWorkers(id)`, `workerLogs(id, workerId)`, `catalogGpus()`, `billedUsd(endpointId)`, `health(endpointId)`, `chatCompletion(endpointId, body, signal)`, `openaiBaseURL(endpointId)`; `type RunpodHttpLike = Pick<RunpodHttp, …all of the above>` for fakes.

- [ ] **Step 1: Create `src/adapters/driven/runpod/types.ts`**

```ts
export interface CreateEndpointRequest {
  name: string
  type: "QUEUE"
  scaling: { type: "QUEUE_DELAY"; queueDelay: number }
  gpu: { pools: string[]; count: number; minCudaVersion?: string }
  image: string
  env: Record<string, string>
  disk: number
  workers: { min: number; max: number; idleTimeout: number }
  /** Per-request execution timeout in milliseconds. */
  timeout: number
  flashboot: "OFF" | "FLASHBOOT"
  dataCenterIds?: string[]
}

export interface EndpointPatch {
  workers?: { min?: number; max?: number; idleTimeout?: number }
  env?: Record<string, string>
}

export interface EndpointInfo {
  id: string
  name: string
  env?: Record<string, string>
  image?: string
  workers?: { min: number; max: number; idleTimeout?: number }
  gpu?: { pools?: string[]; count?: number }
  createdAt?: string
}

export interface WorkerInfo {
  id: string
  status: string
  gpuTypeId?: string
  dataCenterId?: string
}

export interface HealthInfo {
  jobs: { completed: number; failed: number; inProgress: number; inQueue: number; retried: number }
  workers: { idle: number; initializing: number; ready: number; running: number; throttled: number }
}

export interface GpuCatalogEntry {
  id: string
  pool?: string
  memory?: number
  price?: { secure?: number; community?: number; serverless?: number }
}
```

- [ ] **Step 2: Write the failing test**

`test/runpod-http.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { RunpodError, RunpodHttp } from "../src/adapters/driven/runpod/http.ts"

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>

function fakeFetch(handlers: Handler[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    const handler = handlers.shift()
    if (!handler) throw new Error(`unexpected fetch ${url}`)
    return handler(url, init ?? {})
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

function client(handlers: Handler[], sleeps: number[] = []) {
  const f = fakeFetch(handlers)
  const c = new RunpodHttp({ apiKey: "rp_key", fetch: f.fetchImpl, sleep: async (ms) => { sleeps.push(ms) } })
  return { c, calls: f.calls }
}

test("createEndpoint posts JSON with bearer auth to REST v2", async () => {
  const { c, calls } = client([json(201, { id: "ep1", name: "oc-runpod-m" })])
  const body = { name: "oc-runpod-m", type: "QUEUE" as const, scaling: { type: "QUEUE_DELAY" as const, queueDelay: 1 }, gpu: { pools: ["AMPERE_48"], count: 1 }, image: "img", env: {}, disk: 20, workers: { min: 0, max: 1, idleTimeout: 120 }, timeout: 600000, flashboot: "FLASHBOOT" as const }
  const ep = await c.createEndpoint(body)
  assert.equal(ep.id, "ep1")
  assert.equal(calls[0]!.url, "https://api.runpod.io/v2/serverless")
  assert.equal(calls[0]!.init.method, "POST")
  const headers = calls[0]!.init.headers as Record<string, string>
  assert.equal(headers.authorization, "Bearer rp_key")
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), body)
})

test("problem+json errors become RunpodError with status, title and detail", async () => {
  const { c } = client([json(400, { title: "Bad Request", status: 400, detail: "gpu.pools is required" })])
  await assert.rejects(c.getEndpoint("x"), (error: unknown) => {
    assert.ok(error instanceof RunpodError)
    assert.equal(error.status, 400)
    assert.equal(error.title, "Bad Request")
    assert.equal(error.detail, "gpu.pools is required")
    assert.match(error.message, /RunPod 400 Bad Request: gpu\.pools is required/)
    return true
  })
})

test("429 and 5xx are retried with exponential backoff, then succeed", async () => {
  const sleeps: number[] = []
  const { c, calls } = client([json(429, { title: "Too Many" }), json(502, { title: "Bad Gateway" }), json(200, { id: "ep1", name: "n" })], sleeps)
  const ep = await c.getEndpoint("ep1")
  assert.equal(ep.id, "ep1")
  assert.equal(calls.length, 3)
  assert.deepEqual(sleeps, [1000, 2000])
})

test("gives up after maxRetries", async () => {
  const f = fakeFetch([json(503, {}), json(503, {}), json(503, {}), json(503, {})])
  const c = new RunpodHttp({ apiKey: "k", fetch: f.fetchImpl, sleep: async () => {}, maxRetries: 3 })
  await assert.rejects(c.getEndpoint("ep1"), (e: unknown) => e instanceof RunpodError && e.status === 503)
  assert.equal(f.calls.length, 4)
})

test("listEndpoints follows cursor pagination and unwraps the data array", async () => {
  const { c, calls } = client([
    json(200, { data: [{ id: "a", name: "oc-runpod-a" }], pagination: { nextCursor: "c2", hasNextPage: true } }),
    json(200, { data: [{ id: "b", name: "oc-runpod-b" }], pagination: { hasNextPage: false } }),
  ])
  const list = await c.listEndpoints()
  assert.deepEqual(list.map((e) => e.id), ["a", "b"])
  assert.match(calls[1]!.url, /\?cursor=c2$/)
})

test("listEndpoints accepts a bare array response", async () => {
  const { c } = client([json(200, [{ id: "a", name: "n" }])])
  assert.equal((await c.listEndpoints()).length, 1)
})

test("patchEndpoint sends only the given fields; deleteEndpoint accepts 204", async () => {
  const { c, calls } = client([json(200, { id: "ep1", name: "n" }), new Response(null, { status: 204 })])
  await c.patchEndpoint("ep1", { workers: { min: 0, max: 0 } })
  assert.equal(calls[0]!.init.method, "PATCH")
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { workers: { min: 0, max: 0 } })
  await c.deleteEndpoint("ep1")
  assert.equal(calls[1]!.init.method, "DELETE")
  assert.equal(calls[1]!.url, "https://api.runpod.io/v2/serverless/ep1")
})

test("health hits the runtime host and fills missing counters with zero", async () => {
  const { c, calls } = client([json(200, { workers: { idle: 1 } })])
  const h = await c.health("ep1")
  assert.equal(calls[0]!.url, "https://api.runpod.ai/v2/ep1/health")
  assert.deepEqual(h.workers, { idle: 1, initializing: 0, ready: 0, running: 0, throttled: 0 })
  assert.equal(h.jobs.inQueue, 0)
})

test("chatCompletion posts to the OpenAI route and forwards the abort signal", async () => {
  const { c, calls } = client([json(200, { choices: [] })])
  const controller = new AbortController()
  await c.chatCompletion("ep1", { model: "m", messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }, controller.signal)
  assert.equal(calls[0]!.url, "https://api.runpod.ai/v2/ep1/openai/v1/chat/completions")
  assert.equal(JSON.parse(String(calls[0]!.init.body)).max_tokens, 1)
  assert.equal(calls[0]!.init.signal, controller.signal)
  assert.equal(c.openaiBaseURL("ep1"), "https://api.runpod.ai/v2/ep1/openai/v1")
})

test("an aborted signal is not retried", async () => {
  const { c, calls } = client([() => { throw new Error("aborted") }])
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(c.chatCompletion("ep1", { model: "m" }, controller.signal), /aborted/)
  assert.equal(calls.length, 1)
})

test("billedUsd sums record totals and returns null for unknown shapes", async () => {
  const a = client([json(200, { records: [{ totalAmount: 0.12 }, { totalAmount: 0.3 }] })])
  assert.equal(await a.c.billedUsd("ep1"), 0.42)
  assert.match(a.calls[0]!.url, /\/v2\/billing\/serverless\?endpointId=ep1$/)
  const b = client([json(200, { metadata: { totals: { totalAmount: 1.5 } } })])
  assert.equal(await b.c.billedUsd("ep1"), 1.5)
  const d = client([json(200, { something: "else" })])
  assert.equal(await d.c.billedUsd("ep1"), null)
})

test("workerLogs normalises arrays, objects and plain text to a string", async () => {
  const a = client([json(200, [{ message: "line1" }, "line2"])])
  assert.equal(await a.c.workerLogs("ep1", "w1"), "line1\nline2")
  assert.equal(a.calls[0]!.url, "https://api.runpod.io/v2/serverless/ep1/workers/w1/logs")
  const b = client([new Response("raw text log", { status: 200, headers: { "content-type": "text/plain" } })])
  assert.equal(await b.c.workerLogs("ep1", "w1"), "raw text log")
  const d = client([json(200, { logs: ["x", "y"] })])
  assert.equal(await d.c.workerLogs("ep1", "w1"), "x\ny")
})

test("catalogGpus and listWorkers unwrap items", async () => {
  const { c, calls } = client([
    json(200, { data: [{ id: "NVIDIA A40", pool: "AMPERE_48", price: { serverless: 1.22 } }] }),
    json(200, { workers: [{ id: "w1", status: "UNHEALTHY" }] }),
  ])
  assert.equal((await c.catalogGpus())[0]!.pool, "AMPERE_48")
  assert.match(calls[0]!.url, /\/v2\/catalog\/gpus\?product=SERVERLESS$/)
  assert.equal((await c.listWorkers("ep1"))[0]!.status, "UNHEALTHY")
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find `src/adapters/driven/runpod/http.ts`.

- [ ] **Step 4: Implement `src/adapters/driven/runpod/http.ts`**

```ts
import type { CreateEndpointRequest, EndpointInfo, EndpointPatch, GpuCatalogEntry, HealthInfo, WorkerInfo } from "./types.ts"

export const API_BASE = "https://api.runpod.io/v2"
export const RUNTIME_BASE = "https://api.runpod.ai/v2"

export class RunpodError extends Error {
  readonly status: number
  readonly title: string
  readonly detail: string | null
  constructor(status: number, title: string, detail: string | null, context: string) {
    super(`RunPod ${status} ${title}${detail ? `: ${detail}` : ""} (${context})`)
    this.name = "RunpodError"
    this.status = status
    this.title = title
    this.detail = detail
  }
}

export interface RunpodClientOptions {
  apiKey: string
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  apiBase?: string
  runtimeBase?: string
  maxRetries?: number
}

export interface ChatCompletionBody {
  model: string
  messages?: { role: string; content: string }[]
  max_tokens?: number
  stream?: boolean
}

interface RequestInitLike {
  signal?: AbortSignal
  text?: boolean
}

export class RunpodHttp {
  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly apiBase: string
  private readonly runtimeBase: string
  private readonly maxRetries: number

  constructor(options: RunpodClientOptions) {
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetch ?? fetch
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.apiBase = (options.apiBase ?? API_BASE).replace(/\/+$/, "")
    this.runtimeBase = (options.runtimeBase ?? RUNTIME_BASE).replace(/\/+$/, "")
    this.maxRetries = options.maxRetries ?? 3
  }

  openaiBaseURL(endpointId: string): string {
    return `${this.runtimeBase}/${endpointId}/openai/v1`
  }

  async listEndpoints(): Promise<EndpointInfo[]> {
    const out: EndpointInfo[] = []
    let cursor: string | undefined
    do {
      const url = `${this.apiBase}/serverless${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`
      const page = await this.request<unknown>("GET", url)
      out.push(...extractItems<EndpointInfo>(page))
      cursor = nextCursor(page)
    } while (cursor)
    return out
  }

  createEndpoint(body: CreateEndpointRequest): Promise<EndpointInfo> {
    return this.request<EndpointInfo>("POST", `${this.apiBase}/serverless`, body)
  }

  getEndpoint(id: string): Promise<EndpointInfo> {
    return this.request<EndpointInfo>("GET", `${this.apiBase}/serverless/${id}`)
  }

  patchEndpoint(id: string, patch: EndpointPatch): Promise<EndpointInfo> {
    return this.request<EndpointInfo>("PATCH", `${this.apiBase}/serverless/${id}`, patch)
  }

  async deleteEndpoint(id: string): Promise<void> {
    await this.request<unknown>("DELETE", `${this.apiBase}/serverless/${id}`)
  }

  async listWorkers(id: string): Promise<WorkerInfo[]> {
    return extractItems<WorkerInfo>(await this.request<unknown>("GET", `${this.apiBase}/serverless/${id}/workers`))
  }

  async workerLogs(id: string, workerId: string): Promise<string> {
    const raw = await this.request<string>("GET", `${this.apiBase}/serverless/${id}/workers/${workerId}/logs`, undefined, { text: true })
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return raw
    }
    return linesOf(parsed)
  }

  async catalogGpus(): Promise<GpuCatalogEntry[]> {
    return extractItems<GpuCatalogEntry>(await this.request<unknown>("GET", `${this.apiBase}/catalog/gpus?product=SERVERLESS`))
  }

  /** Best-effort actual spend for one endpoint; null when the payload has no recognisable totals. */
  async billedUsd(endpointId: string): Promise<number | null> {
    const page = await this.request<unknown>("GET", `${this.apiBase}/billing/serverless?endpointId=${encodeURIComponent(endpointId)}`)
    const amounts = extractItems<{ totalAmount?: unknown }>(page)
      .map((r) => r.totalAmount)
      .filter((v): v is number => typeof v === "number")
    if (amounts.length > 0) return Math.round(amounts.reduce((a, b) => a + b, 0) * 1e6) / 1e6
    const total = (page as { metadata?: { totals?: { totalAmount?: unknown } } } | null)?.metadata?.totals?.totalAmount
    return typeof total === "number" ? total : null
  }

  async health(endpointId: string): Promise<HealthInfo> {
    const raw = (await this.request<Partial<HealthInfo> | null>("GET", `${this.runtimeBase}/${endpointId}/health`)) ?? {}
    const w = raw.workers ?? {}
    const j = raw.jobs ?? {}
    return {
      jobs: { completed: j.completed ?? 0, failed: j.failed ?? 0, inProgress: j.inProgress ?? 0, inQueue: j.inQueue ?? 0, retried: j.retried ?? 0 },
      workers: { idle: w.idle ?? 0, initializing: w.initializing ?? 0, ready: w.ready ?? 0, running: w.running ?? 0, throttled: w.throttled ?? 0 },
    }
  }

  async chatCompletion(endpointId: string, body: ChatCompletionBody, signal: AbortSignal): Promise<unknown> {
    return this.request<unknown>("POST", `${this.openaiBaseURL(endpointId)}/chat/completions`, body, { signal })
  }

  private async request<T>(method: string, url: string, body?: unknown, init: RequestInitLike = {}): Promise<T> {
    const context = `${method} ${url}`
    for (let attempt = 0; ; attempt++) {
      let response: Response
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", accept: "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: init.signal,
        })
      } catch (error) {
        if (init.signal?.aborted || attempt >= this.maxRetries) throw error
        await this.sleep(1000 * 2 ** attempt)
        continue
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt >= this.maxRetries) throw await this.toError(response, context)
        await this.sleep(1000 * 2 ** attempt)
        continue
      }
      if (!response.ok) throw await this.toError(response, context)
      if (response.status === 204) return undefined as T
      const text = await response.text()
      if (init.text) return text as T
      return (text ? JSON.parse(text) : undefined) as T
    }
  }

  private async toError(response: Response, context: string): Promise<RunpodError> {
    let title = response.statusText || "error"
    let detail: string | null = null
    try {
      const problem = (await response.json()) as { title?: unknown; detail?: unknown; message?: unknown }
      if (typeof problem.title === "string") title = problem.title
      if (typeof problem.detail === "string") detail = problem.detail
      else if (typeof problem.message === "string") detail = problem.message
    } catch {
      // non-JSON error body: keep the status text
    }
    return new RunpodError(response.status, title, detail, context)
  }
}

export type RunpodHttpLike = Pick<
  RunpodHttp,
  "openaiBaseURL" | "listEndpoints" | "createEndpoint" | "getEndpoint" | "patchEndpoint" | "deleteEndpoint" | "listWorkers" | "workerLogs" | "catalogGpus" | "billedUsd" | "health" | "chatCompletion"
>

const ITEM_KEYS = ["data", "items", "endpoints", "results", "workers", "gpus", "records"] as const

function extractItems<T>(page: unknown): T[] {
  if (Array.isArray(page)) return page as T[]
  if (page && typeof page === "object") {
    for (const key of ITEM_KEYS) {
      const value = (page as Record<string, unknown>)[key]
      if (Array.isArray(value)) return value as T[]
    }
  }
  return []
}

function nextCursor(page: unknown): string | undefined {
  const pagination = (page as { pagination?: { nextCursor?: unknown; hasNextPage?: unknown } } | null)?.pagination
  if (!pagination || pagination.hasNextPage === false) return undefined
  return typeof pagination.nextCursor === "string" && pagination.nextCursor ? pagination.nextCursor : undefined
}

function linesOf(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return value.map((line) => (typeof line === "string" ? line : String((line as { message?: unknown })?.message ?? JSON.stringify(line)))).join("\n")
  }
  if (value && typeof value === "object") {
    for (const key of ["logs", "lines", "data"]) {
      const inner = (value as Record<string, unknown>)[key]
      if (Array.isArray(inner) || typeof inner === "string") return linesOf(inner)
    }
  }
  return JSON.stringify(value)
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm run check`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git rm -q src/adapters/driven/.gitkeep
git add src/adapters/driven/runpod/types.ts src/adapters/driven/runpod/http.ts test/runpod-http.test.ts
git commit -m "feat(runpod): REST v2 HTTP client with retries, pagination and runtime routes"
```

---

### Task 7: RunPod compute provider and price catalog adapters

**Files:**
- Create: `src/adapters/driven/runpod/pools.ts`, `src/adapters/driven/runpod/compute-provider.ts`, `src/adapters/driven/runpod/price-catalog.ts`
- Test: `test/runpod-compute-provider.test.ts`, `test/runpod-price-catalog.test.ts`

**Interfaces:**
- Consumes: `ComputeProviderPort`, `ComputeError`, `RemoteEndpoint`, `HealthSnapshot` (core ports), `EndpointSpec` (domain), `PriceCatalogPort`, `PoolRate`, `ClockPort`, `RunpodHttpLike`, `RunpodError`, types (Task 6).
- Produces: `POOLS: Record<string, { label; vramGb; fallbackUsdPerHour }>`, `MARKER_ENV = "OPENCODE_RUNPOD"`, `HASH_ENV = "OPENCODE_RUNPOD_HASH"`, `class RunpodComputeProvider implements ComputeProviderPort { constructor(http: RunpodHttpLike) }`, `toCreateBody(spec: EndpointSpec): CreateEndpointRequest`, `class RunpodPriceCatalog implements PriceCatalogPort { constructor(http: Pick<RunpodHttpLike, "catalogGpus"> | null, clock: ClockPort, ttlMs = 600000) }`.

- [ ] **Step 1: Create `src/adapters/driven/runpod/pools.ts`**

```ts
export interface PoolInfo {
  readonly label: string
  readonly vramGb: number
  /** Flex worker $/h from runpod.io/pricing on 2026-09-26; used only when the live catalog is unavailable. */
  readonly fallbackUsdPerHour: number
}

/** RunPod serverless GPU pools. Keys are the `gpu.pools` ids accepted by POST /v2/serverless. */
export const POOLS: Readonly<Record<string, PoolInfo>> = {
  AMPERE_16: { label: "A4000/A4500 16GB", vramGb: 16, fallbackUsdPerHour: 0.58 },
  AMPERE_24: { label: "L4/A5000/3090 24GB", vramGb: 24, fallbackUsdPerHour: 0.69 },
  ADA_24: { label: "RTX 4090 24GB", vramGb: 24, fallbackUsdPerHour: 1.1 },
  ADA_32_PRO: { label: "RTX 5090 32GB", vramGb: 32, fallbackUsdPerHour: 1.58 },
  AMPERE_48: { label: "A6000/A40 48GB", vramGb: 48, fallbackUsdPerHour: 1.22 },
  ADA_48_PRO: { label: "L40/L40S/6000Ada 48GB", vramGb: 48, fallbackUsdPerHour: 1.75 },
  AMPERE_80: { label: "A100 80GB", vramGb: 80, fallbackUsdPerHour: 2.72 },
  ADA_80_PRO: { label: "H100 80GB", vramGb: 80, fallbackUsdPerHour: 4.79 },
  BLACKWELL_96: { label: "RTX PRO 6000 96GB", vramGb: 96, fallbackUsdPerHour: 3.49 },
  HOPPER_141: { label: "H200 141GB", vramGb: 141, fallbackUsdPerHour: 5.93 },
}
```

- [ ] **Step 2: Write the failing tests**

`test/runpod-compute-provider.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { HASH_ENV, MARKER_ENV, RunpodComputeProvider, toCreateBody } from "../src/adapters/driven/runpod/compute-provider.ts"
import { RunpodError, type RunpodHttpLike } from "../src/adapters/driven/runpod/http.ts"
import type { EndpointInfo, WorkerInfo } from "../src/adapters/driven/runpod/types.ts"
import type { EndpointSpec } from "../src/core/domain/endpoint.ts"
import { ComputeError } from "../src/core/ports/compute-provider.ts"

const spec: EndpointSpec = {
  name: "oc-runpod-m",
  modelID: "m",
  recipe: { image: "runpod/worker-v1-vllm:v2.27.2", env: { MODEL_NAME: "Qwen/Qwen3-8B", OPENCODE_RUNPOD_HASH: "user-supplied-junk" }, secretEnv: { HF_TOKEN: "hf_x" }, diskGb: 42 },
  gpu: { pool: "AMPERE_48", count: 2, minCudaVersion: "12.8" },
  workers: { min: 0, max: 1, idleTimeoutSec: 120 },
  executionTimeoutSec: 600,
  flashboot: true,
  dataCenterIds: ["EU-RO-1"],
  hash: "abcdef0123456789",
}

class FakeHttp implements RunpodHttpLike {
  calls: string[] = []
  endpoints: EndpointInfo[] = []
  workers: WorkerInfo[] = []
  logs = ""
  chatError: Error | null = null
  deleteError: Error | null = null
  openaiBaseURL(id: string) { return `https://api.runpod.ai/v2/${id}/openai/v1` }
  async listEndpoints() { this.calls.push("list"); return this.endpoints }
  async createEndpoint(body: Parameters<RunpodHttpLike["createEndpoint"]>[0]) { this.calls.push(`create:${JSON.stringify(body)}`); return { id: "ep9", name: body.name } }
  async getEndpoint(id: string) { return { id, name: "n" } }
  async patchEndpoint(id: string, patch: Parameters<RunpodHttpLike["patchEndpoint"]>[1]) { this.calls.push(`patch:${id}:${JSON.stringify(patch)}`); return { id, name: "n" } }
  async deleteEndpoint(id: string) { this.calls.push(`delete:${id}`); if (this.deleteError) throw this.deleteError }
  async listWorkers() { return this.workers }
  async workerLogs(_id: string, workerId: string) { this.calls.push(`logs:${workerId}`); return this.logs }
  async catalogGpus() { return [] }
  async billedUsd() { return 0.5 }
  async health() { return { jobs: { completed: 0, failed: 0, inProgress: 0, inQueue: 0, retried: 0 }, workers: { idle: 1, initializing: 2, ready: 0, running: 3, throttled: 4 } } }
  async chatCompletion(id: string) { this.calls.push(`chat:${id}`); if (this.chatError) throw this.chatError; return {} }
}

test("toCreateBody maps the spec and appends markers after user env and secrets", () => {
  const body = toCreateBody(spec)
  assert.equal(body.name, "oc-runpod-m")
  assert.equal(body.type, "QUEUE")
  assert.deepEqual(body.scaling, { type: "QUEUE_DELAY", queueDelay: 1 })
  assert.deepEqual(body.gpu, { pools: ["AMPERE_48"], count: 2, minCudaVersion: "12.8" })
  assert.equal(body.image, "runpod/worker-v1-vllm:v2.27.2")
  assert.equal(body.disk, 42)
  assert.deepEqual(body.workers, { min: 0, max: 1, idleTimeout: 120 })
  assert.equal(body.timeout, 600000)
  assert.equal(body.flashboot, "FLASHBOOT")
  assert.deepEqual(body.dataCenterIds, ["EU-RO-1"])
  assert.equal(body.env.MODEL_NAME, "Qwen/Qwen3-8B")
  assert.equal(body.env.HF_TOKEN, "hf_x")
  assert.equal(body.env[MARKER_ENV], "1")
  assert.equal(body.env[HASH_ENV], "abcdef0123456789")
  const noDc = toCreateBody({ ...spec, dataCenterIds: [], flashboot: false })
  assert.equal(noDc.dataCenterIds, undefined)
  assert.equal(noDc.flashboot, "OFF")
})

test("list exposes ids, names and the hash marker; create returns the id", async () => {
  const http = new FakeHttp()
  http.endpoints = [{ id: "a", name: "oc-runpod-a", env: { [HASH_ENV]: "h1" } }, { id: "b", name: "other" }]
  const provider = new RunpodComputeProvider(http)
  assert.deepEqual(await provider.list(), [{ id: "a", name: "oc-runpod-a", hash: "h1" }, { id: "b", name: "other", hash: null }])
  assert.deepEqual(await provider.create(spec), { id: "ep9" })
  assert.equal(provider.inferenceBaseURL("ep9"), "https://api.runpod.ai/v2/ep9/openai/v1")
})

test("scaleToZero patches workers; delete tolerates 404 only", async () => {
  const http = new FakeHttp()
  const provider = new RunpodComputeProvider(http)
  await provider.scaleToZero("ep1")
  assert.equal(http.calls.at(-1), 'patch:ep1:{"workers":{"min":0,"max":0}}')
  http.deleteError = new RunpodError(404, "Not Found", null, "DELETE")
  await provider.delete("ep1")
  http.deleteError = new RunpodError(403, "Forbidden", null, "DELETE")
  await assert.rejects(provider.delete("ep1"), /403/)
})

test("health maps worker counters; billedUsd passes through", async () => {
  const provider = new RunpodComputeProvider(new FakeHttp())
  assert.deepEqual(await provider.health("ep1"), { initializing: 2, running: 3, idle: 1, throttled: 4 })
  assert.equal(await provider.billedUsd("ep1"), 0.5)
})

test("warmup sends a one-token completion and maps HTTP errors to ComputeError kinds", async () => {
  const http = new FakeHttp()
  const provider = new RunpodComputeProvider(http)
  await provider.warmup("ep1", "m", new AbortController().signal)
  assert.equal(http.calls.at(-1), "chat:ep1")
  http.chatError = new RunpodError(400, "Bad Request", "model not found", "POST")
  await assert.rejects(provider.warmup("ep1", "m", new AbortController().signal), (e: unknown) => e instanceof ComputeError && e.kind === "fatal" && e.status === 400)
  http.chatError = new RunpodError(502, "Bad Gateway", null, "POST")
  await assert.rejects(provider.warmup("ep1", "m", new AbortController().signal), (e: unknown) => e instanceof ComputeError && e.kind === "transient" && e.status === 502)
  http.chatError = new RunpodError(429, "Too Many", null, "POST")
  await assert.rejects(provider.warmup("ep1", "m", new AbortController().signal), (e: unknown) => e instanceof ComputeError && e.kind === "transient")
  http.chatError = new Error("socket hang up")
  await assert.rejects(provider.warmup("ep1", "m", new AbortController().signal), (e: unknown) => e instanceof ComputeError && e.kind === "transient" && e.status === null)
})

test("diagnostics returns the last 40 log lines of an unhealthy worker, or null", async () => {
  const http = new FakeHttp()
  const provider = new RunpodComputeProvider(http)
  assert.equal(await provider.diagnostics("ep1"), null)
  http.workers = [{ id: "w1", status: "RUNNING" }, { id: "w2", status: "UNHEALTHY" }]
  http.logs = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n")
  const tail = await provider.diagnostics("ep1")
  assert.equal(http.calls.at(-1), "logs:w2")
  assert.equal(tail?.split("\n").length, 40)
  assert.ok(tail?.startsWith("line 11"))
  assert.ok(tail?.endsWith("line 50"))
})
```

`test/runpod-price-catalog.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { RunpodPriceCatalog } from "../src/adapters/driven/runpod/price-catalog.ts"
import { POOLS } from "../src/adapters/driven/runpod/pools.ts"
import { FakeClock } from "./fakes/clock.ts"

function http(entries: unknown[] | Error) {
  let calls = 0
  return {
    calls: () => calls,
    catalogGpus: async () => {
      calls++
      if (entries instanceof Error) throw entries
      return entries as { id: string; pool?: string; memory?: number; price?: { serverless?: number } }[]
    },
  }
}

test("live catalog price wins and is labelled from the pool table", async () => {
  const h = http([{ id: "NVIDIA A40", pool: "AMPERE_48", memory: 48, price: { serverless: 1.3 } }])
  const catalog = new RunpodPriceCatalog(h, new FakeClock())
  assert.deepEqual(await catalog.rate("AMPERE_48"), { ratePerHour: 1.3, source: "catalog", vramGb: 48, label: "A6000/A40 48GB" })
})

test("missing pool in the live catalog falls back to the static table; unknown pool → 0", async () => {
  const catalog = new RunpodPriceCatalog(http([]), new FakeClock())
  assert.deepEqual(await catalog.rate("ADA_48_PRO"), { ratePerHour: 1.75, source: "fallback", vramGb: 48, label: "L40/L40S/6000Ada 48GB" })
  assert.deepEqual(await catalog.rate("NOPE"), { ratePerHour: 0, source: "fallback", vramGb: null, label: "NOPE" })
})

test("no http (no API key) and catalog errors both use the static table", async () => {
  const offline = new RunpodPriceCatalog(null, new FakeClock())
  assert.equal((await offline.rate("AMPERE_16")).ratePerHour, 0.58)
  const failing = new RunpodPriceCatalog(http(new Error("down")), new FakeClock())
  assert.equal((await failing.rate("AMPERE_16")).source, "fallback")
})

test("the live catalog is cached for the TTL and refreshed afterwards", async () => {
  const clock = new FakeClock()
  const h = http([{ id: "x", pool: "AMPERE_16", price: { serverless: 0.6 } }])
  const catalog = new RunpodPriceCatalog(h, clock, 1000)
  await catalog.rate("AMPERE_16")
  await catalog.rate("AMPERE_48")
  assert.equal(h.calls(), 1)
  await clock.advance(1001)
  await catalog.rate("AMPERE_16")
  assert.equal(h.calls(), 2)
})

test("knownPools lists the static table", () => {
  const catalog = new RunpodPriceCatalog(null, new FakeClock())
  assert.deepEqual([...catalog.knownPools()].sort(), Object.keys(POOLS).sort())
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot find `compute-provider.ts` / `price-catalog.ts`.

- [ ] **Step 4: Implement `src/adapters/driven/runpod/compute-provider.ts`**

```ts
import type { EndpointSpec } from "../../../core/domain/endpoint.ts"
import { ComputeError, type ComputeProviderPort, type HealthSnapshot, type RemoteEndpoint } from "../../../core/ports/compute-provider.ts"
import { RunpodError, type RunpodHttpLike } from "./http.ts"
import type { CreateEndpointRequest } from "./types.ts"

export const MARKER_ENV = "OPENCODE_RUNPOD"
export const HASH_ENV = "OPENCODE_RUNPOD_HASH"
const LOG_TAIL_LINES = 40

export function toCreateBody(spec: EndpointSpec): CreateEndpointRequest {
  const env: Record<string, string> = { ...spec.recipe.env, ...spec.recipe.secretEnv }
  env[MARKER_ENV] = "1"
  env[HASH_ENV] = spec.hash
  const body: CreateEndpointRequest = {
    name: spec.name,
    type: "QUEUE",
    scaling: { type: "QUEUE_DELAY", queueDelay: 1 },
    gpu: { pools: [spec.gpu.pool], count: spec.gpu.count, minCudaVersion: spec.gpu.minCudaVersion },
    image: spec.recipe.image,
    env,
    disk: spec.recipe.diskGb,
    workers: { min: spec.workers.min, max: spec.workers.max, idleTimeout: spec.workers.idleTimeoutSec },
    timeout: spec.executionTimeoutSec * 1000,
    flashboot: spec.flashboot ? "FLASHBOOT" : "OFF",
  }
  if (spec.dataCenterIds.length > 0) body.dataCenterIds = [...spec.dataCenterIds]
  return body
}

export class RunpodComputeProvider implements ComputeProviderPort {
  private readonly http: RunpodHttpLike

  constructor(http: RunpodHttpLike) {
    this.http = http
  }

  async list(): Promise<RemoteEndpoint[]> {
    const endpoints = await this.http.listEndpoints()
    return endpoints.map((ep) => ({ id: ep.id, name: ep.name, hash: ep.env?.[HASH_ENV] ?? null }))
  }

  async create(spec: EndpointSpec): Promise<{ id: string }> {
    const created = await this.http.createEndpoint(toCreateBody(spec))
    return { id: created.id }
  }

  async scaleToZero(id: string): Promise<void> {
    await this.http.patchEndpoint(id, { workers: { min: 0, max: 0 } })
  }

  async delete(id: string): Promise<void> {
    try {
      await this.http.deleteEndpoint(id)
    } catch (error) {
      if (error instanceof RunpodError && error.status === 404) return
      throw error
    }
  }

  async health(id: string): Promise<HealthSnapshot> {
    const info = await this.http.health(id)
    return { initializing: info.workers.initializing, running: info.workers.running, idle: info.workers.idle, throttled: info.workers.throttled }
  }

  async warmup(id: string, modelID: string, signal: AbortSignal): Promise<void> {
    try {
      await this.http.chatCompletion(id, { model: modelID, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }, signal)
    } catch (error) {
      if (error instanceof RunpodError) {
        const fatal = error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429
        throw new ComputeError(error.message, fatal ? "fatal" : "transient", error.status)
      }
      throw new ComputeError((error as Error).message ?? String(error), "transient", null)
    }
  }

  async diagnostics(id: string): Promise<string | null> {
    const workers = await this.http.listWorkers(id)
    const unhealthy = workers.find((w) => w.status.toUpperCase() === "UNHEALTHY")
    if (!unhealthy) return null
    const text = await this.http.workerLogs(id, unhealthy.id)
    const lines = text.trim().split("\n")
    return lines.slice(-LOG_TAIL_LINES).join("\n")
  }

  billedUsd(id: string): Promise<number | null> {
    return this.http.billedUsd(id)
  }

  inferenceBaseURL(id: string): string {
    return this.http.openaiBaseURL(id)
  }
}
```

- [ ] **Step 5: Implement `src/adapters/driven/runpod/price-catalog.ts`**

```ts
import type { PoolRate } from "../../../core/domain/quote.ts"
import type { ClockPort } from "../../../core/ports/clock.ts"
import type { PriceCatalogPort } from "../../../core/ports/price-catalog.ts"
import { POOLS } from "./pools.ts"
import type { GpuCatalogEntry } from "./types.ts"

export const CATALOG_TTL_MS = 10 * 60_000

export class RunpodPriceCatalog implements PriceCatalogPort {
  private readonly http: { catalogGpus(): Promise<GpuCatalogEntry[]> } | null
  private readonly clock: ClockPort
  private readonly ttlMs: number
  private cache: { at: number; entries: GpuCatalogEntry[] | null } | null = null

  constructor(http: { catalogGpus(): Promise<GpuCatalogEntry[]> } | null, clock: ClockPort, ttlMs: number = CATALOG_TTL_MS) {
    this.http = http
    this.clock = clock
    this.ttlMs = ttlMs
  }

  knownPools(): readonly string[] {
    return Object.keys(POOLS)
  }

  async rate(pool: string): Promise<PoolRate> {
    const info = POOLS[pool]
    const entries = await this.entries()
    const live = entries?.find((e) => e.pool === pool && typeof e.price?.serverless === "number")
    if (live) return { ratePerHour: live.price!.serverless!, source: "catalog", vramGb: live.memory ?? info?.vramGb ?? null, label: info?.label ?? pool }
    return { ratePerHour: info?.fallbackUsdPerHour ?? 0, source: "fallback", vramGb: info?.vramGb ?? null, label: info?.label ?? pool }
  }

  private async entries(): Promise<GpuCatalogEntry[] | null> {
    if (!this.http) return null
    const now = this.clock.now()
    if (this.cache && now - this.cache.at <= this.ttlMs) return this.cache.entries
    let entries: GpuCatalogEntry[] | null = null
    try {
      entries = await this.http.catalogGpus()
    } catch {
      entries = null // remembered for one TTL so a broken catalog is not hammered
    }
    this.cache = { at: now, entries }
    return entries
  }
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npm run check`
Expected: pass (architecture test: these files import only core and their own folder).

- [ ] **Step 7: Commit**

```bash
git add src/adapters/driven/runpod test/runpod-compute-provider.test.ts test/runpod-price-catalog.test.ts
git commit -m "feat(runpod): compute provider and price catalog adapters over REST v2"
```

---

### Task 8: vLLM worker recipe adapter with model-family presets

**Files:**
- Create: `src/adapters/driven/vllm/presets.ts`, `src/adapters/driven/vllm/recipe.ts`
- Test: `test/vllm-recipe.test.ts`

**Interfaces:**
- Consumes: `WorkerRecipePort`, `WorkerRecipe`, `ModelConfig`, `Settings`, `DEFAULT_WEIGHTS_GB`.
- Produces: `FAMILIES: Record<string, { toolParser: string | null; reasoningParser: string | null }>`, `inferFamily(hf): string | null`, `parsersFor({ family, toolParser?, reasoningParser? })`, `diskGb(weightsGb)`, `class VllmWorkerRecipe implements WorkerRecipePort { constructor(hfToken: string | null) }`.

- [ ] **Step 1: Write the failing test**

`test/vllm-recipe.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { FAMILIES, inferFamily, parsersFor } from "../src/adapters/driven/vllm/presets.ts"
import { VllmWorkerRecipe, diskGb } from "../src/adapters/driven/vllm/recipe.ts"
import { sampleModel, sampleSettings } from "./fakes/fixtures.ts"

test("inferFamily recognises common repos", () => {
  assert.equal(inferFamily("Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8"), "qwen3-coder")
  assert.equal(inferFamily("huihui-ai/Huihui-Qwen3.8-27B-abliterated"), "qwen3")
  assert.equal(inferFamily("zai-org/GLM-4.7-Flash"), "glm-4.7")
  assert.equal(inferFamily("openai/gpt-oss-20b"), "gpt-oss")
  assert.equal(inferFamily("mistralai/Devstral-Small-2-24B"), "devstral")
  assert.equal(inferFamily("Kwaipilot/KAT-Coder-V2.5"), null)
})

test("parsersFor: explicit values win, null disables, undefined falls back to the preset", () => {
  assert.deepEqual(parsersFor({ family: "qwen3" }), FAMILIES.qwen3)
  assert.deepEqual(parsersFor({ family: "qwen3", toolParser: "qwen3_xml" }), { toolParser: "qwen3_xml", reasoningParser: "qwen3" })
  assert.deepEqual(parsersFor({ family: "qwen3", reasoningParser: null }), { toolParser: "hermes", reasoningParser: null })
  assert.deepEqual(parsersFor({ family: null }), { toolParser: null, reasoningParser: null })
})

test("recipe maps model config to vLLM worker env, infers the family and sizes the disk", () => {
  const settings = sampleSettings()
  const model = sampleModel({ env: { GPU_MEMORY_UTILIZATION: "0.92" } })
  const recipe = new VllmWorkerRecipe(null).recipe(model, settings, 31.6)
  assert.equal(recipe.image, "runpod/worker-v1-vllm:v2.27.2")
  assert.deepEqual(recipe.env, {
    MODEL_NAME: "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8",
    OPENAI_SERVED_MODEL_NAME_OVERRIDE: "m",
    MAX_MODEL_LEN: "65536",
    ENABLE_AUTO_TOOL_CHOICE: "true",
    TOOL_CALL_PARSER: "qwen3_xml",
    QUANTIZATION: "fp8",
    GPU_MEMORY_UTILIZATION: "0.92",
  })
  assert.deepEqual(recipe.secretEnv, {})
  assert.equal(recipe.diskGb, diskGb(31.6))
})

test("explicit family, reasoning parser, disabled tools and HF token", () => {
  const settings = sampleSettings()
  const withReasoning = new VllmWorkerRecipe("hf_secret").recipe(sampleModel({ hf: "Qwen/Qwen3-8B", quantization: null }), settings, null)
  assert.equal(withReasoning.env.TOOL_CALL_PARSER, "hermes")
  assert.equal(withReasoning.env.REASONING_PARSER, "qwen3")
  assert.equal(withReasoning.env.QUANTIZATION, undefined)
  assert.deepEqual(withReasoning.secretEnv, { HF_TOKEN: "hf_secret" })
  assert.equal(withReasoning.diskGb, diskGb(60))
  const explicit = new VllmWorkerRecipe(null).recipe(sampleModel({ hf: "Kwaipilot/KAT-Coder-V2.5", family: "qwen3-coder" }), settings, 10)
  assert.equal(explicit.env.TOOL_CALL_PARSER, "qwen3_xml")
  const noTools = new VllmWorkerRecipe(null).recipe(sampleModel({ tools: false }), settings, 10)
  assert.equal(noTools.env.ENABLE_AUTO_TOOL_CHOICE, "false")
  assert.equal(noTools.env.TOOL_CALL_PARSER, undefined)
  const disabledParser = new VllmWorkerRecipe(null).recipe(sampleModel({ toolParser: null }), settings, 10)
  assert.equal(disabledParser.env.ENABLE_AUTO_TOOL_CHOICE, "false")
})

test("HF_TOKEN in user env is moved to secretEnv so it is never hashed", () => {
  const recipe = new VllmWorkerRecipe(null).recipe(sampleModel({ env: { HF_TOKEN: "leaked" } }), sampleSettings(), 10)
  assert.equal(recipe.env.HF_TOKEN, undefined)
  assert.equal(recipe.secretEnv.HF_TOKEN, "leaked")
})

test("disk grows with weights with a floor of 20 GB", () => {
  assert.equal(diskGb(1), 20)
  assert.equal(diskGb(30), Math.ceil(30 * 1.15) + 10)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find the vllm modules.

- [ ] **Step 3: Implement `src/adapters/driven/vllm/presets.ts`**

```ts
export interface FamilyPreset {
  /** vLLM TOOL_CALL_PARSER; null = no tool parser. */
  readonly toolParser: string | null
  /** vLLM REASONING_PARSER; null = none. */
  readonly reasoningParser: string | null
}

export const FAMILIES: Readonly<Record<string, FamilyPreset>> = {
  "qwen3-coder": { toolParser: "qwen3_xml", reasoningParser: null },
  qwen3: { toolParser: "hermes", reasoningParser: "qwen3" },
  "glm-4.7": { toolParser: "glm47", reasoningParser: "glm47" },
  "glm-4.5": { toolParser: "glm45", reasoningParser: "glm45" },
  "gpt-oss": { toolParser: "openai", reasoningParser: null },
  devstral: { toolParser: "mistral", reasoningParser: null },
  mistral: { toolParser: "mistral", reasoningParser: null },
  llama3: { toolParser: "llama3_json", reasoningParser: null },
  "deepseek-v3": { toolParser: "deepseek_v3", reasoningParser: "deepseek_r1" },
}

const FAMILY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/qwen3[-_.]?coder/i, "qwen3-coder"],
  [/qwen3/i, "qwen3"],
  [/glm[-_]?4\.7/i, "glm-4.7"],
  [/glm[-_]?4\.[56]/i, "glm-4.5"],
  [/gpt[-_]?oss/i, "gpt-oss"],
  [/devstral/i, "devstral"],
  [/mistral|mixtral|magistral/i, "mistral"],
  [/llama[-_]?3/i, "llama3"],
  [/deepseek[-_]?(v3|r1)/i, "deepseek-v3"],
]

export function inferFamily(hf: string): string | null {
  for (const [pattern, family] of FAMILY_PATTERNS) if (pattern.test(hf)) return family
  return null
}

export function parsersFor(input: { family: string | null; toolParser?: string | null; reasoningParser?: string | null }): FamilyPreset {
  const preset = input.family === null ? undefined : FAMILIES[input.family]
  return {
    toolParser: input.toolParser === undefined ? (preset?.toolParser ?? null) : input.toolParser,
    reasoningParser: input.reasoningParser === undefined ? (preset?.reasoningParser ?? null) : input.reasoningParser,
  }
}
```

- [ ] **Step 4: Implement `src/adapters/driven/vllm/recipe.ts`**

```ts
import type { WorkerRecipe } from "../../../core/domain/endpoint.ts"
import type { ModelConfig, Settings } from "../../../core/domain/model.ts"
import { DEFAULT_WEIGHTS_GB } from "../../../core/domain/quote.ts"
import type { WorkerRecipePort } from "../../../core/ports/worker-recipe.ts"
import { inferFamily, parsersFor } from "./presets.ts"

/** Container disk: weights + 15% headroom + 10 GB for image and cache, at least 20 GB. */
export function diskGb(weightsGb: number): number {
  return Math.max(20, Math.ceil(weightsGb * 1.15) + 10)
}

/** Maps a model to the `runpod/worker-v1-vllm` environment (any `vllm serve` flag may be added via `model.env`). */
export class VllmWorkerRecipe implements WorkerRecipePort {
  private readonly hfToken: string | null

  constructor(hfToken: string | null) {
    this.hfToken = hfToken
  }

  recipe(model: ModelConfig, settings: Settings, weightsGb: number | null): WorkerRecipe {
    const family = model.family ?? inferFamily(model.hf)
    const parsers = parsersFor({ family, toolParser: model.toolParser, reasoningParser: model.reasoningParser })
    const toolParser = model.tools ? parsers.toolParser : null
    const env: Record<string, string> = {
      MODEL_NAME: model.hf,
      OPENAI_SERVED_MODEL_NAME_OVERRIDE: model.id,
      MAX_MODEL_LEN: String(model.context),
      ENABLE_AUTO_TOOL_CHOICE: toolParser ? "true" : "false",
    }
    if (toolParser) env.TOOL_CALL_PARSER = toolParser
    if (parsers.reasoningParser) env.REASONING_PARSER = parsers.reasoningParser
    if (model.quantization) env.QUANTIZATION = model.quantization
    const secretEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(model.env)) {
      if (key === "HF_TOKEN") secretEnv.HF_TOKEN = value
      else env[key] = value
    }
    if (this.hfToken) secretEnv.HF_TOKEN = this.hfToken
    return { image: settings.workerImage, env, secretEnv, diskGb: diskGb(weightsGb ?? DEFAULT_WEIGHTS_GB) }
  }
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm run check`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/driven/vllm test/vllm-recipe.test.ts
git commit -m "feat(vllm): worker recipe adapter with model-family parser presets"
```

---

### Task 9: Hugging Face weights adapter

**Files:**
- Create: `src/adapters/driven/huggingface/weights-info.ts`
- Test: `test/hf-weights.test.ts`

**Interfaces:**
- Produces: `interface HfSizeResult { weightsGb; files; source: "safetensors" | "gguf" }`, `fetchWeightsGb(hf, { token?, fetch? }): Promise<HfSizeResult | null>`, `class HfWeightsInfo implements WeightsInfoPort { constructor(opts: { token: string | null; fetch?: typeof fetch }) }`.

- [ ] **Step 1: Write the failing test**

`test/hf-weights.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { HfWeightsInfo, fetchWeightsGb } from "../src/adapters/driven/huggingface/weights-info.ts"
import { sampleModel } from "./fakes/fixtures.ts"

function fetchReturning(status: number, body: unknown, seen: { url?: string; headers?: Record<string, string> } = {}) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen.url = String(input)
    seen.headers = (init?.headers ?? {}) as Record<string, string>
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }) as unknown as typeof fetch
}

const GB = 1e9

test("sums safetensors shards and reports GB with one decimal", async () => {
  const seen: { url?: string; headers?: Record<string, string> } = {}
  const result = await fetchWeightsGb("Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8", {
    fetch: fetchReturning(200, { siblings: [{ rfilename: "model-00001-of-00002.safetensors", size: 20 * GB }, { rfilename: "model-00002-of-00002.safetensors", size: 11.55 * GB }, { rfilename: "README.md", size: 1000 }] }, seen),
  })
  assert.deepEqual(result, { weightsGb: 31.6, files: 2, source: "safetensors" })
  assert.equal(seen.url, "https://huggingface.co/api/models/Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8?blobs=true")
  assert.equal(seen.headers?.authorization, undefined)
})

test("falls back to gguf files and sends the token when given", async () => {
  const seen: { url?: string; headers?: Record<string, string> } = {}
  const result = await fetchWeightsGb("org/repo", { token: "hf_x", fetch: fetchReturning(200, { siblings: [{ rfilename: "model-Q4_K_M.gguf", size: 18 * GB }] }, seen) })
  assert.deepEqual(result, { weightsGb: 18, files: 1, source: "gguf" })
  assert.equal(seen.headers?.authorization, "Bearer hf_x")
})

test("returns null on HTTP errors, network errors and repos without weights", async () => {
  assert.equal(await fetchWeightsGb("org/missing", { fetch: fetchReturning(404, { error: "not found" }) }), null)
  assert.equal(await fetchWeightsGb("org/empty", { fetch: fetchReturning(200, { siblings: [{ rfilename: "README.md", size: 10 }] }) }), null)
  const failing = (async () => { throw new Error("offline") }) as unknown as typeof fetch
  assert.equal(await fetchWeightsGb("org/repo", { fetch: failing }), null)
})

test("HfWeightsInfo implements the port for a model", async () => {
  const port = new HfWeightsInfo({ token: null, fetch: fetchReturning(200, { siblings: [{ rfilename: "a.safetensors", size: 5 * GB }] }) })
  assert.equal(await port.weightsGb(sampleModel()), 5)
  const empty = new HfWeightsInfo({ token: null, fetch: fetchReturning(500, {}) })
  assert.equal(await empty.weightsGb(sampleModel()), null)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find `weights-info.ts`.

- [ ] **Step 3: Implement `src/adapters/driven/huggingface/weights-info.ts`**

```ts
import type { ModelConfig } from "../../../core/domain/model.ts"
import type { WeightsInfoPort } from "../../../core/ports/weights-info.ts"

export interface HfSizeResult {
  weightsGb: number
  files: number
  source: "safetensors" | "gguf"
}

interface Sibling {
  rfilename?: string
  size?: number
}

/** Total size of a repo's weight files via the public Hub API (`?blobs=true` includes sizes). Null when unknown. */
export async function fetchWeightsGb(hf: string, opts: { token?: string | null; fetch?: typeof fetch } = {}): Promise<HfSizeResult | null> {
  const fetchImpl = opts.fetch ?? fetch
  const headers: Record<string, string> = { accept: "application/json" }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  let response: Response
  try {
    response = await fetchImpl(`https://huggingface.co/api/models/${hf}?blobs=true`, { headers })
  } catch {
    return null
  }
  if (!response.ok) return null
  let data: { siblings?: Sibling[] }
  try {
    data = (await response.json()) as { siblings?: Sibling[] }
  } catch {
    return null
  }
  const siblings = data.siblings ?? []
  const withExt = (ext: string) => siblings.filter((s) => typeof s.size === "number" && s.rfilename?.endsWith(ext))
  let files = withExt(".safetensors")
  let source: HfSizeResult["source"] = "safetensors"
  if (files.length === 0) {
    files = withExt(".gguf")
    source = "gguf"
  }
  if (files.length === 0) return null
  const bytes = files.reduce((sum, s) => sum + (s.size ?? 0), 0)
  return { weightsGb: Math.round(bytes / 1e8) / 10, files: files.length, source }
}

export class HfWeightsInfo implements WeightsInfoPort {
  private readonly token: string | null
  private readonly fetchImpl: typeof fetch | undefined

  constructor(opts: { token: string | null; fetch?: typeof fetch }) {
    this.token = opts.token
    this.fetchImpl = opts.fetch
  }

  async weightsGb(model: ModelConfig): Promise<number | null> {
    const result = await fetchWeightsGb(model.hf, { token: this.token, fetch: this.fetchImpl })
    return result?.weightsGb ?? null
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm run check`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/driven/huggingface test/hf-weights.test.ts
git commit -m "feat(huggingface): weights size adapter"
```

---

### Task 10: RPC contract and text formatting (driving boundary)

**Files:**
- Create: `src/adapters/driving/rpc/contract.ts`, `src/adapters/driving/rpc/format.ts`, `rpc.ts` (root)
- Test: `test/rpc-contract.test.ts`, `test/format.test.ts`

**Interfaces:**
- Consumes: domain types `Quote`, `StateEvent`, `ModelStatus`, `StatusReport`, `Phase`, `NoticeLevel`.
- Produces (`contract.ts`): zod schemas `PhaseSchema`, `QuoteSchema: z.ZodType<Quote>`, `StateEventSchema: z.ZodType<StateEvent>`, `ModelStatusSchema: z.ZodType<ModelStatus>`, `StatusReportSchema: z.ZodType<StatusReport>`, `NoticeSchema`, and `RunpodRpc` (`id: "runpod"`, methods `status/up/down/confirm`, events `confirm.requested/state/notice`).
- Produces (`format.ts`): `formatUsd`, `formatDuration`, `formatQuote`, `phaseLabel`, `footerLabel`, `formatStatus`.

- [ ] **Step 1: Write the failing tests**

`test/rpc-contract.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { QuoteSchema, RunpodRpc, StateEventSchema, StatusReportSchema } from "../rpc.ts"

test("contract exposes the four methods and three events", () => {
  assert.equal(RunpodRpc.id, "runpod")
  assert.deepEqual(Object.keys(RunpodRpc.methods).sort(), ["confirm", "down", "status", "up"])
  assert.deepEqual(Object.keys(RunpodRpc.events).sort(), ["confirm.requested", "notice", "state"])
})

test("schemas accept well-formed payloads and reject bad phases", () => {
  const quote = { modelID: "m", hf: "a/b", gpu: "AMPERE_48", gpuLabel: "A6000/A40 48GB", gpuCount: 1, ratePerHour: 1.22, rateSource: "catalog", weightsGb: 31.6, estColdStartSec: 156, idleTimeout: 120, idleWindowUsd: 0.04, warnings: [], blocked: null }
  assert.equal(QuoteSchema.safeParse(quote).success, true)
  const state = { modelID: "m", phase: "warming", detail: "starting", elapsedSec: 3, spendUsd: 0.001, ratePerHour: 1.22, gpu: "AMPERE_48", gpuLabel: "A6000/A40 48GB" }
  assert.equal(StateEventSchema.safeParse(state).success, true)
  assert.equal(StateEventSchema.safeParse({ ...state, phase: "hot" }).success, false)
  assert.equal(StatusReportSchema.safeParse({ models: [], orphans: [] }).success, true)
})
```

`test/format.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { footerLabel, formatDuration, formatQuote, formatStatus, formatUsd, phaseLabel } from "../src/adapters/driving/rpc/format.ts"
import type { StateEvent, StatusReport } from "../src/core/domain/events.ts"
import type { Quote } from "../src/core/domain/quote.ts"

const quote: Quote = { modelID: "m", hf: "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8", gpu: "AMPERE_48", gpuLabel: "A6000/A40 48GB", gpuCount: 1, ratePerHour: 1.22, rateSource: "catalog", weightsGb: 31.6, estColdStartSec: 156, idleTimeout: 120, idleWindowUsd: 0.0407, warnings: ["weights ≈31.6 GB may not fit 24 GB of VRAM"], blocked: null }
const event: StateEvent = { modelID: "m", phase: "ready", detail: null, elapsedSec: 142, spendUsd: 0.4211, ratePerHour: 1.22, gpu: "AMPERE_48", gpuLabel: "A6000/A40 48GB" }

test("formatUsd and formatDuration", () => {
  assert.equal(formatUsd(0.4211), "$0.42")
  assert.equal(formatUsd(3), "$3.00")
  assert.equal(formatDuration(142), "2m 22s")
  assert.equal(formatDuration(45), "45s")
  assert.equal(formatDuration(-3), "0s")
})

test("formatQuote lists model, GPU rate, cold start, idle window and warnings", () => {
  const text = formatQuote(quote)
  assert.match(text, /^m ← Qwen\/Qwen3-Coder-30B-A3B-Instruct-FP8/)
  assert.match(text, /A6000\/A40 48GB at \$1\.22\/h/)
  assert.match(text, /Cold start ≈ 2m 36s for ≈31\.6 GB/)
  assert.match(text, /Stays warm 120s after each request ≈ \$0\.04/)
  assert.match(text, /Warning: weights ≈31\.6 GB may not fit/)
  assert.match(formatQuote({ ...quote, gpuCount: 2, rateSource: "fallback", weightsGb: null }), /×2 at .*\(static price table\)/)
})

test("phaseLabel and footerLabel", () => {
  assert.equal(phaseLabel({ phase: "ready", elapsedSec: null }), "warm")
  assert.equal(phaseLabel({ phase: "warming", elapsedSec: 87 }), "warming 87s")
  assert.equal(phaseLabel({ phase: "idle", elapsedSec: null }), "cold")
  assert.equal(phaseLabel({ phase: "confirming", elapsedSec: null }), "confirm?")
  assert.equal(footerLabel(null), "")
  assert.equal(footerLabel(event), "runpod A6000/A40 48GB · warm · $1.22/h · ≈$0.42")
})

test("formatStatus prints one line per model plus orphans", () => {
  const status: StatusReport = {
    models: [
      { modelID: "m", phase: "ready", detail: "ready in 142s", spendUsd: 0.42, ratePerHour: 1.22, gpu: "AMPERE_48", gpuLabel: "A6000/A40 48GB", endpointID: "ep1", gpuCount: 1, billedUsd: 0.5, lastRequestAt: 1 },
      { modelID: "n", phase: "cold", detail: null, spendUsd: 0, ratePerHour: 2.72, gpu: "AMPERE_80", gpuLabel: "A100 80GB", endpointID: null, gpuCount: 2, billedUsd: null, lastRequestAt: null },
    ],
    orphans: [{ id: "epX", name: "oc-runpod-old" }],
  }
  const lines = formatStatus(status).split("\n")
  assert.equal(lines[0], "m: ready [ep1] · A6000/A40 48GB $1.22/h · session ≈$0.42 · billed $0.50 · ready in 142s")
  assert.equal(lines[1], "n: cold · A100 80GB ×2 $2.72/h · session ≈$0.00")
  assert.equal(lines[2], "Unmanaged oc-runpod-* endpoints: oc-runpod-old [epX]")
  assert.equal(formatStatus({ models: [], orphans: [] }), "RunPod: no models configured (options.models)")
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot find `rpc.ts` / `format.ts`.

- [ ] **Step 3: Implement `src/adapters/driving/rpc/contract.ts`**

```ts
import type { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import type { ModelStatus, NoticeLevel, StateEvent, StatusReport } from "../../../core/domain/events.ts"
import type { Phase } from "../../../core/domain/endpoint.ts"
import type { Quote } from "../../../core/domain/quote.ts"

export const PhaseSchema: z.ZodType<Phase> = z.enum(["cold", "confirming", "creating", "warming", "ready", "idle", "deleting", "error"])

export const QuoteSchema: z.ZodType<Quote> = z.object({
  modelID: z.string(),
  hf: z.string(),
  gpu: z.string(),
  gpuLabel: z.string(),
  gpuCount: z.number().int().min(1),
  ratePerHour: z.number(),
  rateSource: z.enum(["catalog", "fallback"]),
  weightsGb: z.number().nullable(),
  estColdStartSec: z.number(),
  idleTimeout: z.number(),
  idleWindowUsd: z.number(),
  warnings: z.array(z.string()),
  blocked: z.string().nullable(),
})

export const StateEventSchema: z.ZodType<StateEvent> = z.object({
  modelID: z.string(),
  phase: PhaseSchema,
  detail: z.string().nullable(),
  elapsedSec: z.number().nullable(),
  spendUsd: z.number(),
  ratePerHour: z.number(),
  gpu: z.string(),
  gpuLabel: z.string(),
})

export const ModelStatusSchema: z.ZodType<ModelStatus> = z.object({
  modelID: z.string(),
  phase: PhaseSchema,
  detail: z.string().nullable(),
  spendUsd: z.number(),
  ratePerHour: z.number(),
  gpu: z.string(),
  gpuLabel: z.string(),
  endpointID: z.string().nullable(),
  gpuCount: z.number().int(),
  billedUsd: z.number().nullable(),
  lastRequestAt: z.number().nullable(),
})

export const StatusReportSchema: z.ZodType<StatusReport> = z.object({
  models: z.array(ModelStatusSchema),
  orphans: z.array(z.object({ id: z.string(), name: z.string() })),
})

export const NoticeLevelSchema: z.ZodType<NoticeLevel> = z.enum(["info", "warning", "error"])
export const NoticeSchema = z.object({ level: NoticeLevelSchema, message: z.string() })
export type Notice = z.infer<typeof NoticeSchema>

/** RPC contract shared by the server plugin (`ctx.rpc.register`) and the TUI plugin (`client.rpc`). */
export const RunpodRpc = {
  id: "runpod",
  methods: {
    status: { input: z.object({}), output: StatusReportSchema },
    up: { input: z.object({ modelID: z.string() }), output: z.object({ baseURL: z.string() }) },
    down: { input: z.object({ modelID: z.string().optional() }), output: z.object({ deleted: z.array(z.string()) }) },
    confirm: { input: z.object({ requestID: z.string(), accepted: z.boolean() }), output: z.object({ ok: z.boolean() }) },
  },
  events: {
    "confirm.requested": { schema: z.object({ requestID: z.string(), quote: QuoteSchema }) },
    state: { schema: StateEventSchema },
    notice: { schema: NoticeSchema },
  },
} as const satisfies Rpc.PortableDefinition
```

If `satisfies Rpc.PortableDefinition` fails on the zod ↔ Standard Schema generics, use `satisfies Rpc.Definition`; keep a `satisfies`.

Root `rpc.ts`:
```ts
export * from "./src/adapters/driving/rpc/contract.ts"
```

- [ ] **Step 4: Implement `src/adapters/driving/rpc/format.ts`**

```ts
import type { Phase } from "../../../core/domain/endpoint.ts"
import type { StateEvent, StatusReport } from "../../../core/domain/events.ts"
import type { Quote } from "../../../core/domain/quote.ts"

export function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

export function formatQuote(q: Quote): string {
  const lines = [
    `${q.modelID} ← ${q.hf}`,
    `GPU: ${q.gpuLabel}${q.gpuCount > 1 ? ` ×${q.gpuCount}` : ""} at ${formatUsd(q.ratePerHour)}/h while a worker runs${q.rateSource === "fallback" ? " (static price table)" : ""}`,
    `Cold start ≈ ${formatDuration(q.estColdStartSec)}${q.weightsGb !== null ? ` for ≈${q.weightsGb} GB of weights` : ""}`,
    `Stays warm ${q.idleTimeout}s after each request ≈ ${formatUsd(q.idleWindowUsd)} per idle window`,
  ]
  for (const warning of q.warnings) lines.push(`Warning: ${warning}`)
  return lines.join("\n")
}

const PHASE_LABELS: Record<Phase, string> = {
  cold: "cold",
  idle: "cold",
  confirming: "confirm?",
  creating: "creating",
  warming: "warming",
  ready: "warm",
  deleting: "deleting",
  error: "error",
}

export function phaseLabel(e: { phase: Phase; elapsedSec: number | null }): string {
  return e.phase === "warming" ? `warming ${e.elapsedSec ?? 0}s` : PHASE_LABELS[e.phase]
}

export function footerLabel(e: StateEvent | null): string {
  if (!e) return ""
  return `runpod ${e.gpuLabel} · ${phaseLabel(e)} · ${formatUsd(e.ratePerHour)}/h · ≈${formatUsd(e.spendUsd)}`
}

export function formatStatus(s: StatusReport): string {
  if (s.models.length === 0) return "RunPod: no models configured (options.models)"
  const lines = s.models.map((m) => {
    const parts = [
      `${m.modelID}: ${m.phase}${m.endpointID ? ` [${m.endpointID}]` : ""}`,
      `${m.gpuLabel}${m.gpuCount > 1 ? ` ×${m.gpuCount}` : ""} ${formatUsd(m.ratePerHour)}/h`,
      `session ≈${formatUsd(m.spendUsd)}`,
    ]
    if (m.billedUsd !== null) parts.push(`billed ${formatUsd(m.billedUsd)}`)
    if (m.detail) parts.push(m.detail)
    return parts.join(" · ")
  })
  if (s.orphans.length > 0) lines.push(`Unmanaged oc-runpod-* endpoints: ${s.orphans.map((o) => `${o.name} [${o.id}]`).join(", ")}`)
  return lines.join("\n")
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm run check`
Expected: pass. The `z.ZodType<Quote>` annotations fail typecheck if the DTO drifts from the domain type — that is intended.

- [ ] **Step 6: Commit**

```bash
git add rpc.ts src/adapters/driving/rpc test/rpc-contract.test.ts test/format.test.ts
git commit -m "feat(rpc): typed RPC contract and text formatting for quotes, status and footer"
```

---

### Task 11: opencode and system driven adapters (state store, notifier, confirmation, clock, logger)

**Files:**
- Create: `src/adapters/driven/opencode/state-store.ts`, `notifier.ts`, `confirmation.ts`; `src/adapters/driven/system/clock.ts`, `logger.ts`
- Test: `test/opencode-adapters.test.ts`

**Interfaces:**
- Produces: `class OpencodeStateStore implements StateStorePort { constructor(storage: { get(key): Promise<unknown>; set(key, value): Promise<void>; remove(key): Promise<void> }) }`; `class RpcNotifier implements NotifierPort { constructor(emit: { state(event: StateEvent): void; notice(level: NoticeLevel, message: string): void }) }`; `class ConfirmBroker { constructor(timeoutMs, timers?); request(issue: (requestID) => void): Promise<boolean>; resolve(requestID, accepted): boolean; readonly size }`; `class RpcConfirmation implements ConfirmationPort { constructor(broker: ConfirmBroker, emit: (requestID: string, quote: Quote) => void) }`; `class SystemClock implements ClockPort`; `class ConsoleLogger implements LoggerPort { constructor(prefix: string) }`.

- [ ] **Step 1: Write the failing test**

`test/opencode-adapters.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { ConfirmBroker, RpcConfirmation } from "../src/adapters/driven/opencode/confirmation.ts"
import { RpcNotifier } from "../src/adapters/driven/opencode/notifier.ts"
import { OpencodeStateStore } from "../src/adapters/driven/opencode/state-store.ts"
import { SystemClock } from "../src/adapters/driven/system/clock.ts"
import { ConsoleLogger } from "../src/adapters/driven/system/logger.ts"
import type { Quote } from "../src/core/domain/quote.ts"

function timers() {
  const pending: { id: number; fn: () => void }[] = []
  let seq = 0
  return {
    pending,
    setTimer: (fn: () => void, _ms: number) => { const id = ++seq; pending.push({ id, fn }); return id },
    clearTimer: (id: unknown) => { const i = pending.findIndex((t) => t.id === id); if (i >= 0) pending.splice(i, 1) },
    fire: () => { const t = pending.shift(); t?.fn() },
  }
}

const quote: Quote = { modelID: "m", hf: "a/b", gpu: "AMPERE_48", gpuLabel: "A6000/A40 48GB", gpuCount: 1, ratePerHour: 1.22, rateSource: "catalog", weightsGb: 10, estColdStartSec: 80, idleTimeout: 120, idleWindowUsd: 0.04, warnings: [], blocked: null }

test("ConfirmBroker: accept, decline, unknown id, timeout", async () => {
  const t = timers()
  const broker = new ConfirmBroker(1000, t)
  let issued = ""
  const accepted = broker.request((id) => { issued = id })
  assert.ok(issued.length > 0)
  assert.equal(broker.size, 1)
  assert.equal(broker.resolve("nope", true), false)
  assert.equal(broker.resolve(issued, true), true)
  assert.equal(await accepted, true)
  assert.equal(broker.size, 0)
  assert.equal(t.pending.length, 0)

  const declined = broker.request((id) => { issued = id })
  broker.resolve(issued, false)
  assert.equal(await declined, false)

  const timedOut = broker.request((id) => { issued = id })
  t.fire()
  assert.equal(await timedOut, false)
  assert.equal(broker.resolve(issued, true), false)
})

test("RpcConfirmation emits the quote with the request id and resolves through the broker", async () => {
  const t = timers()
  const broker = new ConfirmBroker(1000, t)
  const emitted: { requestID: string; quote: Quote }[] = []
  const confirmation = new RpcConfirmation(broker, (requestID, q) => { emitted.push({ requestID, quote: q }) })
  const pending = confirmation.ask(quote)
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0]!.quote, quote)
  assert.equal(broker.resolve(emitted[0]!.requestID, true), true)
  assert.equal(await pending, true)
})

test("RpcNotifier forwards state and notices", () => {
  const seen: string[] = []
  const notifier = new RpcNotifier({ state: (e) => seen.push(`state:${e.phase}`), notice: (level, message) => seen.push(`${level}:${message}`) })
  notifier.state({ modelID: "m", phase: "ready", detail: null, elapsedSec: 1, spendUsd: 0, ratePerHour: 1, gpu: "g", gpuLabel: "G" })
  notifier.notice("warning", "careful")
  assert.deepEqual(seen, ["state:ready", "warning:careful"])
})

test("OpencodeStateStore passes through to ctx.storage", async () => {
  const backing = new Map<string, unknown>()
  const store = new OpencodeStateStore({
    get: async (key) => backing.get(key),
    set: async (key, value) => { backing.set(key, value) },
    remove: async (key) => { backing.delete(key) },
  })
  await store.set("k", { a: 1 })
  assert.deepEqual(await store.get<{ a: number }>("k"), { a: 1 })
  await store.remove("k")
  assert.equal(await store.get("k"), undefined)
})

test("SystemClock and ConsoleLogger are usable", async () => {
  const clock = new SystemClock()
  const before = clock.now()
  const id = clock.setTimer(() => {}, 10_000)
  clock.clearTimer(id)
  await clock.sleep(1)
  assert.ok(clock.now() >= before)
  const lines: string[] = []
  const logger = new ConsoleLogger("[t]", (line) => lines.push(line))
  logger.info("hello", { a: 1 })
  logger.warn("oops")
  assert.deepEqual(lines, ['[t] hello {"a":1}', "[t] oops"])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the adapters**

`src/adapters/driven/opencode/state-store.ts`:
```ts
import type { StateStorePort } from "../../../core/ports/state-store.ts"

/** Adapts `ctx.storage` (durable, plugin-scoped JSON) to the StateStorePort. */
export class OpencodeStateStore implements StateStorePort {
  private readonly storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; remove(key: string): Promise<void> }

  constructor(storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; remove(key: string): Promise<void> }) {
    this.storage = storage
  }

  async get<T>(key: string): Promise<T | undefined> {
    return (await this.storage.get(key)) as T | undefined
  }

  set(key: string, value: unknown): Promise<void> {
    return this.storage.set(key, value)
  }

  remove(key: string): Promise<void> {
    return this.storage.remove(key)
  }
}
```
`src/adapters/driven/opencode/notifier.ts`:
```ts
import type { NoticeLevel, StateEvent } from "../../../core/domain/events.ts"
import type { NotifierPort } from "../../../core/ports/notifier.ts"

export interface NotifierEmit {
  state(event: StateEvent): void
  notice(level: NoticeLevel, message: string): void
}

/** Publishes core state changes as RPC events; the composition root supplies the emit functions. */
export class RpcNotifier implements NotifierPort {
  private readonly emit: NotifierEmit

  constructor(emit: NotifierEmit) {
    this.emit = emit
  }

  state(event: StateEvent): void {
    this.emit.state(event)
  }

  notice(level: NoticeLevel, message: string): void {
    this.emit.notice(level, message)
  }
}
```

`src/adapters/driven/opencode/confirmation.ts`:
```ts
import { randomUUID } from "node:crypto"
import type { Quote } from "../../../core/domain/quote.ts"
import type { ConfirmationPort } from "../../../core/ports/confirmation.ts"

interface Pending {
  resolve: (accepted: boolean) => void
  timer: unknown
}

export interface ConfirmTimers {
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (id: unknown) => void
}

/** Pairs an outgoing "please confirm" request with the reply that arrives later over RPC. */
export class ConfirmBroker {
  private readonly timeoutMs: number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (id: unknown) => void
  private readonly pending = new Map<string, Pending>()

  constructor(timeoutMs: number, timers: ConfirmTimers = {}) {
    this.timeoutMs = timeoutMs
    this.setTimer = timers.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = timers.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>))
  }

  request(issue: (requestID: string) => void): Promise<boolean> {
    const requestID = randomUUID()
    return new Promise<boolean>((resolve) => {
      const timer = this.setTimer(() => {
        this.pending.delete(requestID)
        resolve(false)
      }, this.timeoutMs)
      this.pending.set(requestID, { resolve, timer })
      issue(requestID)
    })
  }

  resolve(requestID: string, accepted: boolean): boolean {
    const entry = this.pending.get(requestID)
    if (!entry) return false
    this.pending.delete(requestID)
    this.clearTimer(entry.timer)
    entry.resolve(accepted)
    return true
  }

  get size(): number {
    return this.pending.size
  }
}

/** ConfirmationPort over RPC: emit `confirm.requested`, wait for the `confirm` method to answer. */
export class RpcConfirmation implements ConfirmationPort {
  private readonly broker: ConfirmBroker
  private readonly emit: (requestID: string, quote: Quote) => void

  constructor(broker: ConfirmBroker, emit: (requestID: string, quote: Quote) => void) {
    this.broker = broker
    this.emit = emit
  }

  ask(quote: Quote): Promise<boolean> {
    return this.broker.request((requestID) => this.emit(requestID, quote))
  }
}
```

`src/adapters/driven/system/clock.ts`:
```ts
import type { ClockPort } from "../../../core/ports/clock.ts"

export class SystemClock implements ClockPort {
  now(): number {
    return Date.now()
  }
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
  setTimer(fn: () => void, ms: number): unknown {
    return setTimeout(fn, ms)
  }
  clearTimer(id: unknown): void {
    clearTimeout(id as ReturnType<typeof setTimeout>)
  }
}
```

`src/adapters/driven/system/logger.ts`:
```ts
import type { LoggerPort } from "../../../core/ports/logger.ts"

/** Writes prefixed lines to stderr (captured by the opencode server log). */
export class ConsoleLogger implements LoggerPort {
  private readonly prefix: string
  private readonly write: (line: string) => void

  constructor(prefix: string, write: (line: string) => void = (line) => console.error(line)) {
    this.prefix = prefix
    this.write = write
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this.write(this.line(message, extra))
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this.write(this.line(message, extra))
  }

  private line(message: string, extra?: Record<string, unknown>): string {
    return `${this.prefix} ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}`
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm run check`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/driven/opencode src/adapters/driven/system test/opencode-adapters.test.ts
git commit -m "feat(adapters): opencode storage/RPC notifier/confirmation and system clock/logger"
```

---

### Task 12: Options resolution (driving adapter: opencode config → Settings + secrets)

**Files:**
- Create: `src/adapters/driving/opencode/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: `ModelConfig`, `Settings` (core).
- Produces: `OptionsSchema`, `ModelOptionsSchema`, `class ConfigError`, `resolveSecret(value, deps)`, `resolveSettings(raw: unknown, deps: { env?; readFile?; knownPools: readonly string[] }): { settings: Settings; secrets: { apiKey: string | null; hfToken: string | null } }`.

- [ ] **Step 1: Write the failing test**

`test/config.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { ConfigError, resolveSecret, resolveSettings } from "../src/adapters/driving/opencode/config.ts"

const POOLS = ["AMPERE_16", "ADA_24", "AMPERE_48", "AMPERE_80"]
const resolve = (raw: unknown, env: Record<string, string> = {}) => resolveSettings(raw, { env, knownPools: POOLS })

test("defaults are applied; models keep tri-state parsers for the recipe adapter", () => {
  const { settings, secrets } = resolve(
    { models: { "qwen3-coder-30b": { hf: "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8", gpu: "AMPERE_48", quantization: "fp8" } } },
    { RUNPOD_API_KEY: "rp_test" },
  )
  assert.equal(secrets.apiKey, "rp_test")
  assert.equal(secrets.hfToken, null)
  assert.equal(settings.confirm, true)
  assert.equal(settings.confirmTimeoutSec, 120)
  assert.equal(settings.idleTimeout, 120)
  assert.equal(settings.workersMax, 1)
  assert.equal(settings.executionTimeoutSec, 600)
  assert.equal(settings.coldStartTimeoutSec, 600)
  assert.equal(settings.deleteOnExit, true)
  assert.equal(settings.adoptExisting, true)
  assert.equal(settings.maxHourlyRate, null)
  assert.deepEqual(settings.dataCenterIds, [])
  assert.equal(settings.minCudaVersion, "12.8")
  assert.equal(settings.workerImage, "runpod/worker-v1-vllm:v2.27.2")
  assert.equal(settings.flashboot, true)
  const m = settings.models[0]!
  assert.equal(m.id, "qwen3-coder-30b")
  assert.equal(m.name, "qwen3-coder-30b (RunPod)")
  assert.equal(m.family, null)
  assert.equal(m.toolParser, undefined)
  assert.equal(m.reasoningParser, undefined)
  assert.equal(m.quantization, "fp8")
  assert.equal(m.context, 32768)
  assert.equal(m.output, 8192)
  assert.equal(m.gpuCount, 1)
  assert.equal(m.tools, true)
  assert.equal(m.weightsGb, null)
  assert.deepEqual(m.env, {})
  assert.ok(!("apiKey" in settings))
})

test("unknown gpu pool is a ConfigError naming the key and listing known pools", () => {
  assert.throws(
    () => resolve({ models: { x: { hf: "a/b", gpu: "NOPE" } } }),
    (error: unknown) => error instanceof ConfigError && /models\.x\.gpu: unknown pool "NOPE" \(known: AMPERE_16, ADA_24/.test(error.message),
  )
})

test("unknown option keys, bad model ids and bad HF ids are rejected", () => {
  assert.throws(() => resolve({ bogus: 1 }), ConfigError)
  assert.throws(() => resolve({ models: { "Bad Id": { hf: "a/b", gpu: "ADA_24" } } }), /id must match/)
  assert.throws(() => resolve({ models: { ok: { hf: "not-a-repo", gpu: "ADA_24" } } }), /hf/)
})

test("secret placeholders resolve from env and file; missing values become null", () => {
  assert.equal(resolveSecret("{env:K}", { env: { K: "v" } }), "v")
  assert.equal(resolveSecret("{env:K}", { env: {} }), null)
  assert.equal(resolveSecret("{file:/tmp/k}", { env: {}, readFile: () => "filekey\n" }), "filekey")
  assert.equal(resolveSecret("literal-key", { env: {} }), "literal-key")
  assert.equal(resolveSecret(undefined, { env: {} }), null)
  assert.throws(() => resolveSecret("{file:/nope}", { env: {}, readFile: () => { throw new Error("ENOENT") } }), /cannot read \/nope/)
  assert.equal(resolve({ apiKey: "{env:MISSING}" }).secrets.apiKey, null)
  assert.equal(resolve({ apiKey: "{env:MY_KEY}" }, { MY_KEY: "abc", RUNPOD_API_KEY: "zzz" }).secrets.apiKey, "abc")
  assert.equal(resolve({}, { RUNPOD_API_KEY: "  padded " }).secrets.apiKey, "padded")
  assert.equal(resolve({ hfToken: "hf_lit" }).secrets.hfToken, "hf_lit")
})

test("explicit parser values and family are preserved (null and strings)", () => {
  const { settings } = resolve({ models: { m: { hf: "Qwen/Qwen3-8B", gpu: "ADA_24", toolParser: null, reasoningParser: "qwen3", family: "qwen3", env: { GPU_MEMORY_UTILIZATION: "0.9" } } } })
  const m = settings.models[0]!
  assert.equal(m.toolParser, null)
  assert.equal(m.reasoningParser, "qwen3")
  assert.equal(m.family, "qwen3")
  assert.deepEqual(m.env, { GPU_MEMORY_UTILIZATION: "0.9" })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find `config.ts`.

- [ ] **Step 3: Implement `src/adapters/driving/opencode/config.ts`**

```ts
import { readFileSync } from "node:fs"
import { z } from "zod"
import type { ModelConfig, Settings } from "../../../core/domain/model.ts"

const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,62}$/
const HF_REPO = /^[\w.-]+\/[\w.-]+$/

export const ModelOptionsSchema = z.strictObject({
  name: z.string().min(1).optional(),
  hf: z.string().regex(HF_REPO, "expected a Hugging Face repo id like org/name"),
  gpu: z.string().min(1),
  gpuCount: z.number().int().min(1).max(8).default(1),
  context: z.number().int().min(1024).default(32768),
  output: z.number().int().min(256).default(8192),
  tools: z.boolean().default(true),
  family: z.string().optional(),
  toolParser: z.string().nullable().optional(),
  reasoningParser: z.string().nullable().optional(),
  quantization: z.string().nullable().optional(),
  weightsGb: z.number().positive().nullable().optional(),
  env: z.record(z.string(), z.string()).default({}),
})

export const OptionsSchema = z.strictObject({
  apiKey: z.string().optional(),
  hfToken: z.string().optional(),
  confirm: z.boolean().default(true),
  confirmTimeoutSec: z.number().int().min(5).default(120),
  idleTimeout: z.number().int().min(1).max(3600).default(120),
  workersMax: z.number().int().min(1).max(10).default(1),
  executionTimeoutSec: z.number().int().min(5).default(600),
  coldStartTimeoutSec: z.number().int().min(30).default(600),
  deleteOnExit: z.boolean().default(true),
  adoptExisting: z.boolean().default(true),
  maxHourlyRate: z.number().positive().optional(),
  dataCenterIds: z.array(z.string()).default([]),
  minCudaVersion: z.string().default("12.8"),
  workerImage: z.string().default("runpod/worker-v1-vllm:v2.27.2"),
  flashboot: z.boolean().default(true),
  models: z.record(z.string(), ModelOptionsSchema).default({}),
})

export class ConfigError extends Error {
  constructor(message: string) {
    super(`opencode-runpod config: ${message}`)
    this.name = "ConfigError"
  }
}

export type Env = Readonly<Record<string, string | undefined>>

export interface SecretDeps {
  env?: Env
  readFile?: (path: string) => string
}

export interface ResolveDeps extends SecretDeps {
  knownPools: readonly string[]
}

export interface Secrets {
  apiKey: string | null
  hfToken: string | null
}

/** Resolves `{env:NAME}` / `{file:PATH}` placeholders that opencode did not substitute itself. */
export function resolveSecret(value: string | undefined, deps: SecretDeps = {}): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  if (trimmed === "") return null
  const env = deps.env ?? process.env
  const envMatch = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(trimmed)
  if (envMatch) return env[envMatch[1]!]?.trim() || null
  const fileMatch = /^\{file:(.+)\}$/.exec(trimmed)
  if (fileMatch) {
    const read = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"))
    const path = fileMatch[1]!.replace(/^~(?=\/)/, env.HOME ?? "~")
    try {
      return read(path).trim() || null
    } catch (error) {
      throw new ConfigError(`cannot read ${path}: ${(error as Error).message}`)
    }
  }
  return trimmed
}

export function resolveSettings(raw: unknown, deps: ResolveDeps): { settings: Settings; secrets: Secrets } {
  const env = deps.env ?? process.env
  const parsed = OptionsSchema.safeParse(raw ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    throw new ConfigError(`${issue.path.join(".") || "options"}: ${issue.message}`)
  }
  const o = parsed.data
  const models: ModelConfig[] = []
  for (const [id, m] of Object.entries(o.models)) {
    if (!MODEL_ID.test(id)) throw new ConfigError(`models.${id}: id must match ${MODEL_ID}`)
    if (!deps.knownPools.includes(m.gpu)) {
      throw new ConfigError(`models.${id}.gpu: unknown pool "${m.gpu}" (known: ${deps.knownPools.join(", ")})`)
    }
    models.push({
      id,
      name: m.name ?? `${id} (RunPod)`,
      hf: m.hf,
      gpu: m.gpu,
      gpuCount: m.gpuCount,
      context: m.context,
      output: m.output,
      tools: m.tools,
      family: m.family ?? null,
      toolParser: m.toolParser,
      reasoningParser: m.reasoningParser,
      quantization: m.quantization ?? null,
      weightsGb: m.weightsGb ?? null,
      env: { ...m.env },
    })
  }
  const settings: Settings = {
    confirm: o.confirm,
    confirmTimeoutSec: o.confirmTimeoutSec,
    idleTimeout: o.idleTimeout,
    workersMax: o.workersMax,
    executionTimeoutSec: o.executionTimeoutSec,
    coldStartTimeoutSec: o.coldStartTimeoutSec,
    deleteOnExit: o.deleteOnExit,
    adoptExisting: o.adoptExisting,
    maxHourlyRate: o.maxHourlyRate ?? null,
    dataCenterIds: [...o.dataCenterIds],
    minCudaVersion: o.minCudaVersion,
    workerImage: o.workerImage,
    flashboot: o.flashboot,
    models,
  }
  const secrets: Secrets = {
    apiKey: resolveSecret(o.apiKey, deps) ?? (env.RUNPOD_API_KEY?.trim() || null),
    hfToken: resolveSecret(o.hfToken, deps) ?? (env.HF_TOKEN?.trim() || null),
  }
  return { settings, secrets }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm run check`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/driving/opencode/config.ts test/config.test.ts
git commit -m "feat(opencode): resolve plugin options into domain settings and secrets"
```

---

### Task 13: Provider/model catalog builders and slash commands

**Files:**
- Create: `src/adapters/driving/opencode/provider-catalog.ts`, `src/adapters/driving/opencode/commands.ts`
- Test: `test/provider-catalog.test.ts`, `test/commands.test.ts`

**Interfaces:**
- Consumes: `ModelConfig`, `OperationsPort`, `StatusReport`, `formatStatus`.
- Produces: `PROVIDER_ID = "runpod"`, `PROVIDER_NAME`, `PROVIDER_PACKAGE`, `PLACEHOLDER_BASE_URL`, `buildProviderInfo(apiKey: string | null): Provider.Info`, `buildModelInfo(model: ModelConfig): Model.Info`; `parseArg(text): string | null`, `registerCommands(host: CommandHost, ops: OperationsPort, reply: Reply): Promise<void>` where `CommandHost = { command: { transform(cb: (editor: { add(def: { name; description?; execute(input: { sessionID: string; prompt: { text: string } }): Promise<void> }): void }) => void): Promise<unknown> } }` and `Reply = (sessionID: string, text: string) => Promise<void>`.

- [ ] **Step 1: Write the failing tests**

`test/provider-catalog.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { PLACEHOLDER_BASE_URL, PROVIDER_ID, buildModelInfo, buildProviderInfo } from "../src/adapters/driving/opencode/provider-catalog.ts"
import { sampleModel } from "./fakes/fixtures.ts"

test("provider info uses the openai-compatible package, placeholder URL and long timeouts", () => {
  const info = buildProviderInfo("rp_key")
  assert.equal(info.id, PROVIDER_ID)
  assert.equal(info.name, "RunPod Serverless")
  assert.equal(info.package, "@opencode/ai/providers/openai-compatible")
  assert.equal(info.activation, "enabled")
  assert.equal(info.settings?.baseURL, PLACEHOLDER_BASE_URL)
  assert.equal(info.settings?.apiKey, "rp_key")
  assert.equal(info.settings?.timeout, 600000)
  assert.equal(info.settings?.chunkTimeout, 600000)
  assert.equal(buildProviderInfo(null).settings?.apiKey, "missing-runpod-api-key")
})

test("model info carries limits, tool capability and the model id as wire id", () => {
  const model = buildModelInfo(sampleModel({ name: "M", context: 40000, output: 4000, tools: false }))
  assert.equal(model.id, "m")
  assert.equal(model.modelID, "m")
  assert.equal(model.providerID, "runpod")
  assert.equal(model.name, "M")
  assert.equal(model.capabilities.tools, false)
  assert.deepEqual(model.capabilities.input, ["text"])
  assert.equal(model.limit.context, 40000)
  assert.equal(model.limit.output, 4000)
  assert.equal(model.status, "active")
  assert.equal(model.enabled, true)
})
```

`test/commands.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { parseArg, registerCommands, type CommandHost } from "../src/adapters/driving/opencode/commands.ts"
import type { StatusReport } from "../src/core/domain/events.ts"
import type { OperationsPort } from "../src/core/ports/driving.ts"

type Definition = { name: string; description?: string; execute(input: { sessionID: string; prompt: { text: string } }): Promise<void> }

function host() {
  const defs = new Map<string, Definition>()
  const h: CommandHost = { command: { transform: async (cb) => { cb({ add: (def) => defs.set(def.name, def) }) } } }
  return { h, defs }
}

const report: StatusReport = { models: [{ modelID: "m", phase: "ready", detail: null, spendUsd: 0.1, ratePerHour: 1.22, gpu: "AMPERE_48", gpuLabel: "A6000/A40 48GB", endpointID: "ep1", gpuCount: 1, billedUsd: null, lastRequestAt: 0 }], orphans: [] }

function ops(overrides: Partial<OperationsPort> = {}): OperationsPort & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    status: async () => { calls.push("status"); return report },
    up: async (modelID) => { calls.push(`up:${modelID}`); return `https://x/${modelID}/v1` },
    down: async (modelID) => { calls.push(`down:${modelID ?? "*"}`); return modelID ? [modelID] : ["m", "n"] },
    ...overrides,
  }
}

test("parseArg strips the command token and returns the first argument", () => {
  assert.equal(parseArg("/runpod-up  my-model extra"), "my-model")
  assert.equal(parseArg("my-model"), "my-model")
  assert.equal(parseArg("/runpod-up"), null)
  assert.equal(parseArg("   "), null)
})

test("commands are registered and reply through the reply channel", async () => {
  const { h, defs } = host()
  const o = ops()
  const replies: string[] = []
  await registerCommands(h, o, async (_sessionID, text) => { replies.push(text) })
  assert.deepEqual([...defs.keys()].sort(), ["runpod-down", "runpod-status", "runpod-up"])
  await defs.get("runpod-status")!.execute({ sessionID: "s", prompt: { text: "" } })
  assert.match(replies.at(-1)!, /^m: ready \[ep1\]/)
  await defs.get("runpod-up")!.execute({ sessionID: "s", prompt: { text: "/runpod-up m" } })
  assert.equal(replies.at(-1), "RunPod m is warm at https://x/m/v1")
  await defs.get("runpod-up")!.execute({ sessionID: "s", prompt: { text: "" } })
  assert.equal(replies.at(-1), "Usage: /runpod-up <model-id>")
  await defs.get("runpod-down")!.execute({ sessionID: "s", prompt: { text: "m" } })
  assert.equal(replies.at(-1), "Deleted RunPod endpoint(s): m")
  await defs.get("runpod-down")!.execute({ sessionID: "s", prompt: { text: "all" } })
  assert.equal(replies.at(-1), "Deleted RunPod endpoint(s): m, n")
  assert.deepEqual(o.calls, ["status", "up:m", "down:m", "down:*"])
})

test("errors from the operations port are reported as text, never thrown", async () => {
  const { h, defs } = host()
  const replies: string[] = []
  await registerCommands(h, ops({ up: async () => { throw new Error("RunPod: declined") }, down: async () => [] }), async (_s, text) => { replies.push(text) })
  await defs.get("runpod-up")!.execute({ sessionID: "s", prompt: { text: "m" } })
  assert.equal(replies.at(-1), "RunPod: declined")
  await defs.get("runpod-down")!.execute({ sessionID: "s", prompt: { text: "" } })
  assert.equal(replies.at(-1), "No RunPod endpoints to delete")
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/adapters/driving/opencode/provider-catalog.ts`**

```ts
import type { Model, Provider } from "@opencode/plugin"
import type { ModelConfig } from "../../../core/domain/model.ts"

export const PROVIDER_ID = "runpod"
export const PROVIDER_NAME = "RunPod Serverless"
export const PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible"
/** Replaced per request by the model.request hook once an endpoint is warm. */
export const PLACEHOLDER_BASE_URL = "https://api.runpod.ai/v2/pending/openai/v1"
const REQUEST_TIMEOUT_MS = 600_000

export function buildProviderInfo(apiKey: string | null): Provider.Info {
  return {
    id: PROVIDER_ID as Provider.ID,
    name: PROVIDER_NAME,
    package: PROVIDER_PACKAGE,
    activation: "enabled",
    settings: {
      baseURL: PLACEHOLDER_BASE_URL,
      apiKey: apiKey ?? "missing-runpod-api-key",
      provider: PROVIDER_ID,
      timeout: REQUEST_TIMEOUT_MS,
      chunkTimeout: REQUEST_TIMEOUT_MS,
    },
  }
}

export function buildModelInfo(model: ModelConfig): Model.Info {
  return {
    id: model.id as Model.ID,
    providerID: PROVIDER_ID as Provider.ID,
    modelID: model.id as Model.ID,
    name: model.name,
    capabilities: { tools: model.tools, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: Date.UTC(2026, 0, 1) },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: model.context, output: model.output },
  }
}
```

If `tsc` reports that `Provider.Info` or `Model.Info` requires a field not listed, add exactly that field with its neutral value (`[]`, `{}`, `undefined` as the error allows) — never cast the whole object. If `Provider.ID`/`Model.ID` are not exported as types from `@opencode/plugin`, import them from `@opencode/schema/provider` / `@opencode/schema/model`.

- [ ] **Step 4: Implement `src/adapters/driving/opencode/commands.ts`**

```ts
import type { OperationsPort } from "../../../core/ports/driving.ts"
import { formatStatus } from "../rpc/format.ts"

export interface CommandInvocationLike {
  sessionID: string
  prompt: { text: string }
}

export interface CommandDefinitionLike {
  name: string
  description?: string
  execute(input: CommandInvocationLike): Promise<void>
}

export interface CommandHost {
  command: {
    transform(callback: (editor: { add(definition: CommandDefinitionLike): void }) => void): Promise<unknown>
  }
}

export type Reply = (sessionID: string, text: string) => Promise<void>

/** First argument after the slash command token, or null. */
export function parseArg(text: string): string | null {
  const rest = text.trim().replace(/^\/\S+\s*/, "")
  const first = rest.split(/\s+/)[0]
  return first ? first : null
}

export async function registerCommands(host: CommandHost, ops: OperationsPort, reply: Reply): Promise<void> {
  await host.command.transform((editor) => {
    editor.add({
      name: "runpod-status",
      description: "RunPod endpoints: phase, GPU, $/h and session spend",
      execute: async ({ sessionID }) => {
        await reply(sessionID, formatStatus(await ops.status()))
      },
    })
    editor.add({
      name: "runpod-up",
      description: "Provision and warm a RunPod model without the confirm dialog: /runpod-up <model-id>",
      execute: async ({ sessionID, prompt }) => {
        const modelID = parseArg(prompt.text)
        if (!modelID) {
          await reply(sessionID, "Usage: /runpod-up <model-id>")
          return
        }
        try {
          const baseURL = await ops.up(modelID)
          await reply(sessionID, `RunPod ${modelID} is warm at ${baseURL}`)
        } catch (error) {
          await reply(sessionID, (error as Error).message)
        }
      },
    })
    editor.add({
      name: "runpod-down",
      description: "Delete RunPod endpoint(s) and stop billing: /runpod-down [model-id|all]",
      execute: async ({ sessionID, prompt }) => {
        const arg = parseArg(prompt.text)
        try {
          const deleted = await ops.down(arg && arg !== "all" ? arg : undefined)
          await reply(sessionID, deleted.length > 0 ? `Deleted RunPod endpoint(s): ${deleted.join(", ")}` : "No RunPod endpoints to delete")
        } catch (error) {
          await reply(sessionID, (error as Error).message)
        }
      },
    })
  })
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm run check`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/driving/opencode/provider-catalog.ts src/adapters/driving/opencode/commands.ts test/provider-catalog.test.ts test/commands.test.ts
git commit -m "feat(opencode): provider/model catalog builders and /runpod-* commands"
```

---

### Task 14: Composition root — the opencode server plugin

**Files:**
- Modify: `src/adapters/driving/opencode/plugin.ts` (replace the stub)

**Interfaces:**
- Consumes: everything. Wires `EndpointService` to the adapters, registers the provider, the `model.request` hook, the RPC methods and the commands, and returns the cleanup function.

- [ ] **Step 1: Replace `src/adapters/driving/opencode/plugin.ts`**

```ts
import { Plugin } from "@opencode/plugin"
import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import { EndpointService } from "../../../core/application/endpoint-service.ts"
import { HfWeightsInfo } from "../../driven/huggingface/weights-info.ts"
import { ConfirmBroker, RpcConfirmation } from "../../driven/opencode/confirmation.ts"
import { RpcNotifier } from "../../driven/opencode/notifier.ts"
import { OpencodeStateStore } from "../../driven/opencode/state-store.ts"
import { RunpodComputeProvider } from "../../driven/runpod/compute-provider.ts"
import { RunpodHttp } from "../../driven/runpod/http.ts"
import { RunpodPriceCatalog } from "../../driven/runpod/price-catalog.ts"
import { SystemClock } from "../../driven/system/clock.ts"
import { ConsoleLogger } from "../../driven/system/logger.ts"
import { VllmWorkerRecipe } from "../../driven/vllm/recipe.ts"
import { RunpodRpc } from "../rpc/contract.ts"
import { registerCommands } from "./commands.ts"
import { resolveSettings } from "./config.ts"
import { PROVIDER_ID, buildModelInfo, buildProviderInfo } from "./provider-catalog.ts"

/**
 * Composition root. The only file allowed to import driven adapters: it builds them,
 * hands them to the core as ports, and connects opencode's driving surfaces.
 */
export default Plugin.define({
  id: "runpod",
  async setup(ctx) {
    const logger = new ConsoleLogger("[runpod]")
    const clock = new SystemClock()
    const knownPools = new RunpodPriceCatalog(null, clock).knownPools()
    const { settings, secrets } = resolveSettings(ctx.options, { knownPools })

    const http = secrets.apiKey ? new RunpodHttp({ apiKey: secrets.apiKey }) : null
    const compute = http ? new RunpodComputeProvider(http) : null
    const catalog = new RunpodPriceCatalog(http, clock)
    const broker = new ConfirmBroker(settings.confirmTimeoutSec * 1000)

    let registration: RpcRegistration<typeof RunpodRpc> | undefined
    const fire = (promise: Promise<void> | undefined) => {
      promise?.catch((error: unknown) => logger.warn("rpc emit failed", { error: String(error) }))
    }

    const service = new EndpointService(settings, {
      compute,
      catalog,
      weights: new HfWeightsInfo({ token: secrets.hfToken }),
      recipe: new VllmWorkerRecipe(secrets.hfToken),
      store: new OpencodeStateStore(ctx.storage),
      clock,
      confirmation: new RpcConfirmation(broker, (requestID, quote) => fire(registration?.events.emit("confirm.requested", { requestID, quote }))),
      notifier: new RpcNotifier({
        state: (event) => fire(registration?.events.emit("state", event)),
        notice: (level, message) => fire(registration?.events.emit("notice", { level, message })),
      }),
      logger,
    })

    registration = await ctx.rpc.register(RunpodRpc, {
      status: async () => service.status(),
      up: async ({ modelID }) => ({ baseURL: await service.up(modelID) }),
      down: async ({ modelID }) => ({ deleted: await service.down(modelID) }),
      confirm: async ({ requestID, accepted }) => ({ ok: broker.resolve(requestID, accepted) }),
    })

    const reply = async (sessionID: string, text: string) => {
      fire(registration?.events.emit("notice", { level: "info", message: text }))
      await ctx.session.synthetic({ sessionID, text })
    }

    await ctx.provider.transform((editor) => {
      editor.add({ info: buildProviderInfo(secrets.apiKey), models: settings.models.map(buildModelInfo) })
    })

    await ctx.session.hook(
      "model.request",
      async (event) => {
        event.baseURL = await service.ensureReady(event.model.id)
      },
      { providerID: PROVIDER_ID },
    )

    await registerCommands(
      {
        command: {
          transform: (callback) =>
            ctx.command.transform((editor) =>
              callback({
                add: (definition) =>
                  editor.add({
                    name: definition.name,
                    description: definition.description,
                    execute: (input) => definition.execute({ sessionID: input.sessionID, prompt: { text: input.prompt.text } }),
                  }),
              }),
            ),
        },
      },
      service,
      reply,
    )

    service.start().catch((error: unknown) => logger.warn("startup reconcile failed", { error: String(error) }))

    return async () => {
      await service.stop(10_000)
      await registration?.dispose()
    }
  },
})
```

- [ ] **Step 2: Typecheck and unit tests**

Run: `npm run check`
Expected: pass. Typical fixes if tsc complains: (a) `ctx.storage` → wrap as `{ get: (k) => ctx.storage.get(k), set: (k, v) => ctx.storage.set(k, v as never), remove: (k) => ctx.storage.remove(k) }`; (b) `RpcRegistration` not exported at that path → `import type { RpcRegistration } from "@opencode/plugin/promise/rpc"` is the documented subpath (`./*` export); if missing, declare `let registration: Awaited<ReturnType<typeof ctx.rpc.register<typeof RunpodRpc>>> | undefined`.

- [ ] **Step 3: Verify the plugin loads and registers the provider**

Run (repo root so `.opencode/opencode.jsonc` applies):
```bash
cd /Volumes/dev/projects/runpod-opencode && opencode service restart >/dev/null 2>&1; opencode models 2>&1 | grep -i runpod
```
Expected: `runpod/qwen3-0.6b`. If empty: `opencode --print-logs models 2>&1 | grep -iE "runpod|plugin"` and fix the reported load error (missing `node_modules`, non-erasable syntax, schema field).

- [ ] **Step 4: Verify the hook path without an API key**

In the repo directory run `opencode`, pick `runpod/qwen3-0.6b` via `/models`, send `hi`.
Expected: the request fails with `RunPod: no API key configured — set options.apiKey or the RUNPOD_API_KEY environment variable.` (proves the `model.request` hook reaches `EndpointService`). No RunPod call is made.

- [ ] **Step 5: Verify the `/runpod-status` reply channel (spec §9.1)**

Still in the TUI, switch back to a homelab model and run `/runpod-status`.
- If the text appears and the model does **not** start generating: keep `reply` as written.
- If the model starts a turn from the synthetic message: change `reply` to toast-only —
  ```ts
  const reply = async (_sessionID: string, text: string) => {
    fire(registration?.events.emit("notice", { level: "info", message: text }))
  }
  ```
  and add to the README that command replies show as toasts.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/driving/opencode/plugin.ts
git commit -m "feat(opencode): composition root wiring EndpointService, provider, hook, RPC and commands"
```

---

### Task 15: TUI adapter — confirm dialog, toasts, footer status

**Files:**
- Create: `src/adapters/driving/tui/toasts.ts`
- Modify: `src/adapters/driving/tui/plugin.tsx` (replace the stub)
- Test: `test/toasts.test.ts`

**Interfaces:**
- Consumes: `RunpodRpc`, `formatQuote`, `footerLabel`, `formatDuration`, `formatUsd`, `StateEvent`, `ModelStatus`.
- Produces: `interface ToastDecision { message: string; variant: "info" | "success" | "warning" | "error" }`, `toastFor(prev: StateEvent | undefined, next: StateEvent): ToastDecision | null`.

- [ ] **Step 1: Write the failing test**

`test/toasts.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { toastFor } from "../src/adapters/driving/tui/toasts.ts"
import type { StateEvent } from "../src/core/domain/events.ts"

const base: StateEvent = { modelID: "m", phase: "cold", detail: null, elapsedSec: null, spendUsd: 0, ratePerHour: 1.22, gpu: "AMPERE_48", gpuLabel: "A6000/A40 48GB" }
const at = (phase: StateEvent["phase"], extra: Partial<StateEvent> = {}): StateEvent => ({ ...base, phase, ...extra })

test("phase transitions produce the expected toasts", () => {
  assert.equal(toastFor(undefined, at("confirming"))?.message, undefined)
  assert.deepEqual(toastFor(at("confirming"), at("creating")), { message: "Provisioning m on A6000/A40 48GB · $1.22/h", variant: "info" })
  assert.deepEqual(toastFor(at("creating"), at("warming", { elapsedSec: 0 })), { message: "Cold start of m…", variant: "info" })
  assert.deepEqual(toastFor(at("warming"), at("ready", { elapsedSec: 142, spendUsd: 0.05 })), { message: "m ready in 2m 22s · ≈$0.05", variant: "success" })
  assert.deepEqual(toastFor(at("ready"), at("idle", { spendUsd: 0.11 })), { message: "m scaled to zero · ≈$0.11 this session", variant: "info" })
  assert.deepEqual(toastFor(at("deleting"), at("cold", { spendUsd: 0.31 })), { message: "m endpoint deleted · ≈$0.31", variant: "info" })
  assert.deepEqual(toastFor(at("warming"), at("cold", { detail: "cold start timed out after 600s" })), { message: "m: cold start timed out after 600s", variant: "warning" })
  assert.deepEqual(toastFor(at("confirming"), at("cold", { detail: "provisioning declined" })), { message: "m: provisioning declined", variant: "warning" })
  assert.deepEqual(toastFor(at("deleting"), at("error", { detail: "delete failed: 403" })), { message: "m: delete failed: 403", variant: "error" })
  assert.equal(toastFor(at("ready"), at("deleting")), null)
})

test("startup snapshots and unchanged phases are silent", () => {
  assert.equal(toastFor(undefined, at("idle")), null)
  assert.equal(toastFor(undefined, at("cold")), null)
  assert.equal(toastFor(at("ready"), at("ready")), null)
})

test("warming progress toasts every 30 seconds only", () => {
  assert.equal(toastFor(at("warming", { elapsedSec: 3 }), at("warming", { elapsedSec: 6 })), null)
  assert.deepEqual(toastFor(at("warming", { elapsedSec: 27 }), at("warming", { elapsedSec: 30, detail: "workers: initializing 1" })), { message: "Cold start 30s · workers: initializing 1", variant: "info" })
  assert.equal(toastFor(at("warming", { elapsedSec: 30 }), at("warming", { elapsedSec: 33 })), null)
  assert.deepEqual(toastFor(at("warming", { elapsedSec: 57 }), at("warming", { elapsedSec: 60 })), { message: "Cold start 1m 0s", variant: "info" })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find `toasts.ts`.

- [ ] **Step 3: Implement `src/adapters/driving/tui/toasts.ts`**

```ts
import type { StateEvent } from "../../../core/domain/events.ts"
import { formatDuration, formatUsd } from "../rpc/format.ts"

export interface ToastDecision {
  message: string
  variant: "info" | "success" | "warning" | "error"
}

const PROGRESS_EVERY_SEC = 30

/** Pure decision: which toast (if any) a state event deserves given the previous event for the same model. */
export function toastFor(prev: StateEvent | undefined, next: StateEvent): ToastDecision | null {
  const spend = `≈${formatUsd(next.spendUsd)}`
  if (prev?.phase !== next.phase) {
    switch (next.phase) {
      case "creating":
        return { message: `Provisioning ${next.modelID} on ${next.gpuLabel} · ${formatUsd(next.ratePerHour)}/h`, variant: "info" }
      case "warming":
        return { message: `Cold start of ${next.modelID}…`, variant: "info" }
      case "ready":
        return { message: `${next.modelID} ready${next.elapsedSec !== null ? ` in ${formatDuration(next.elapsedSec)}` : ""} · ${spend}`, variant: "success" }
      case "idle":
        return prev === undefined ? null : { message: `${next.modelID} scaled to zero · ${spend} this session`, variant: "info" }
      case "error":
        return { message: `${next.modelID}: ${next.detail ?? "error"}`, variant: "error" }
      case "cold":
        if (prev?.phase === "deleting") return { message: `${next.modelID} endpoint deleted · ${spend}`, variant: "info" }
        if (prev?.phase === "warming" || prev?.phase === "creating" || prev?.phase === "confirming") {
          return { message: `${next.modelID}: ${next.detail ?? "stopped"}`, variant: "warning" }
        }
        return null
      default:
        return null // confirming, deleting: the dialog / final state speak for themselves
    }
  }
  if (next.phase === "warming" && next.elapsedSec !== null) {
    const before = Math.floor((prev?.elapsedSec ?? 0) / PROGRESS_EVERY_SEC)
    const now = Math.floor(next.elapsedSec / PROGRESS_EVERY_SEC)
    if (now > before) return { message: `Cold start ${formatDuration(next.elapsedSec)}${next.detail ? ` · ${next.detail}` : ""}`, variant: "info" }
  }
  return null
}
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: toast tests pass.

- [ ] **Step 5: Replace `src/adapters/driving/tui/plugin.tsx`**

```tsx
import { Plugin } from "@opencode/plugin/tui"
import { Show } from "solid-js"
import type { ModelStatus, StateEvent } from "../../../core/domain/events.ts"
import { RunpodRpc } from "../rpc/contract.ts"
import { footerLabel, formatQuote } from "../rpc/format.ts"
import { toastFor } from "./toasts.ts"

interface TuiState {
  active: StateEvent | null
  last: Record<string, StateEvent>
}

function fromStatus(m: ModelStatus): StateEvent {
  return { modelID: m.modelID, phase: m.phase, detail: m.detail, elapsedSec: null, spendUsd: m.spendUsd, ratePerHour: m.ratePerHour, gpu: m.gpu, gpuLabel: m.gpuLabel }
}

/** UI adapter: confirm dialog, toasts and a footer status line, all fed by the server plugin's RPC events. */
export default Plugin.define({
  id: "runpod.tui",
  async setup(context) {
    const rpc = context.client.rpc(RunpodRpc)
    const [state, update] = context.storage.memory<TuiState>("runpod", { initial: { active: null, last: {} } })

    const offConfirm = rpc.events.on("confirm.requested", async (event) => {
      const { requestID, quote } = event.data
      const accepted = await context.ui.dialog.confirm({
        title: `RunPod: provision ${quote.modelID}?`,
        message: formatQuote(quote),
        label: { confirm: "Provision", cancel: "Cancel" },
      })
      await rpc.confirm({ requestID, accepted: accepted === true })
    })

    const offState = rpc.events.on("state", (event) => {
      const next = event.data
      const toast = toastFor(state.last[next.modelID], next)
      update((draft) => {
        draft.last[next.modelID] = next
        draft.active = next
      })
      if (toast) context.ui.toast.show({ title: "RunPod", ...toast })
    })

    const offNotice = rpc.events.on("notice", (event) => {
      context.ui.toast.show({ title: "RunPod", message: event.data.message, variant: event.data.level })
    })

    const footer = () => (
      <Show when={state.active}>{(active) => <text fg={context.theme.text.muted}>{footerLabel(active())}</text>}</Show>
    )
    const unslotPrompt = context.ui.slot({ append: "prompt.footer.status", render: footer })
    const unslotHome = context.ui.slot({ append: "home.footer.status", render: footer })

    rpc
      .status({})
      .then((report) => {
        const known = report.models.find((m) => m.endpointID !== null) ?? report.models.find((m) => m.phase !== "cold")
        if (!known) return
        update((draft) => {
          const snapshot = fromStatus(known)
          draft.last[known.modelID] = snapshot
          draft.active = snapshot
        })
      })
      .catch(() => {
        // server plugin not registered (yet); live events will populate the footer later
      })

    return () => {
      offConfirm()
      offState()
      offNotice()
      unslotPrompt()
      unslotHome()
    }
  },
})
```

If `context.theme.text.muted` does not exist in `ResolvedTheme`, use `context.theme.text.base` (the token the docs show).

- [ ] **Step 6: Typecheck**

Run: `npm run check`
Expected: pass (JSX is typechecked against `@opentui/solid`; runtime transform is done by the opencode TUI host).

- [ ] **Step 7: Manual end-to-end in the TUI (real RunPod account, ≈$0.05)**

```bash
cd /Volumes/dev/projects/runpod-opencode && export RUNPOD_API_KEY=<your key> && opencode service restart >/dev/null 2>&1; opencode
```
1. `/models` → pick `runpod/qwen3-0.6b`; send `Reply with one word.`
2. Expected: confirm dialog "RunPod: provision qwen3-0.6b?" with the quote (A4000/A4500 16GB, $0.58/h, cold start estimate). Choose **Provision**.
3. Expected toasts: "Provisioning qwen3-0.6b on A4000/A4500 16GB · $0.58/h", "Cold start of qwen3-0.6b…", progress every 30 s, then "qwen3-0.6b ready in …"; the answer streams in; footer shows `runpod A4000/A4500 16GB · warm · $0.58/h · ≈$0.0x`.
4. `/runpod-status` → one line with `[<endpointID>]`, session ≈$, and (after a minute) billed $.
5. Wait ~75 s without sending anything → toast "qwen3-0.6b scaled to zero · ≈$… this session", footer says `cold`.
6. Send another message → "Cold start of qwen3-0.6b…" without a dialog → answer.
7. `/runpod-down qwen3-0.6b` → reply "Deleted RunPod endpoint(s): qwen3-0.6b"; confirm in the RunPod console that no `oc-runpod-*` endpoint remains.
8. Provision once more, then quit opencode and run `opencode service stop`. Check the RunPod console: the endpoint must be gone (cleanup on plugin dispose). Note whether quitting only the TUI (background service still running) already removed it; record the observed behaviour in the README caveat in Task 16.

- [ ] **Step 8: Commit**

```bash
git add src/adapters/driving/tui test/toasts.test.ts
git commit -m "feat(tui): confirm dialog, state toasts and footer status over RPC"
```

---

### Task 16: Smoke script, README, example config, global install

**Files:**
- Create: `scripts/smoke.ts`, `README.md`, `examples/opencode.jsonc`
- Modify (user-owned, manual): `~/.config/opencode/opencode.json`

- [ ] **Step 1: Create `scripts/smoke.ts`** (real API; run manually with `npm run smoke`)

```ts
import { EndpointService } from "../src/core/application/endpoint-service.ts"
import { HfWeightsInfo } from "../src/adapters/driven/huggingface/weights-info.ts"
import { RunpodComputeProvider } from "../src/adapters/driven/runpod/compute-provider.ts"
import { RunpodHttp } from "../src/adapters/driven/runpod/http.ts"
import { RunpodPriceCatalog } from "../src/adapters/driven/runpod/price-catalog.ts"
import { SystemClock } from "../src/adapters/driven/system/clock.ts"
import { ConsoleLogger } from "../src/adapters/driven/system/logger.ts"
import { VllmWorkerRecipe } from "../src/adapters/driven/vllm/recipe.ts"
import { resolveSettings } from "../src/adapters/driving/opencode/config.ts"
import { formatStatus } from "../src/adapters/driving/rpc/format.ts"

const clock = new SystemClock()
const knownPools = new RunpodPriceCatalog(null, clock).knownPools()
const { settings, secrets } = resolveSettings(
  {
    confirm: false,
    idleTimeout: 30,
    coldStartTimeoutSec: 480,
    models: { "smoke-qwen3-0.6b": { hf: "Qwen/Qwen3-0.6B", gpu: "AMPERE_16", context: 4096, output: 512, family: "qwen3" } },
  },
  { knownPools },
)
if (!secrets.apiKey) {
  console.error("RUNPOD_API_KEY is required")
  process.exit(2)
}

const http = new RunpodHttp({ apiKey: secrets.apiKey })
const store = new Map<string, unknown>()
const service = new EndpointService(settings, {
  compute: new RunpodComputeProvider(http),
  catalog: new RunpodPriceCatalog(http, clock),
  weights: new HfWeightsInfo({ token: secrets.hfToken }),
  recipe: new VllmWorkerRecipe(secrets.hfToken),
  store: {
    get: async <T>(key: string) => store.get(key) as T | undefined,
    set: async (key, value) => {
      store.set(key, value)
    },
    remove: async (key) => {
      store.delete(key)
    },
  },
  clock,
  confirmation: { ask: async () => true },
  notifier: {
    state: (e) => console.log(`[${e.phase}] ${e.detail ?? ""} ≈$${e.spendUsd.toFixed(3)}`),
    notice: (level, message) => console.log(level, message),
  },
  logger: new ConsoleLogger("[smoke]"),
})

const started = Date.now()
try {
  const baseURL = await service.ensureReady("smoke-qwen3-0.6b")
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${secrets.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "smoke-qwen3-0.6b", messages: [{ role: "user", content: "Say hi in three words." }], max_tokens: 16 }),
  })
  console.log("chat", response.status, (await response.text()).slice(0, 300))
} finally {
  console.log("deleted", await service.down())
  console.log(formatStatus(await service.status()))
  console.log("elapsed s", Math.round((Date.now() - started) / 1000))
}
```
Run: `RUNPOD_API_KEY=… npm run smoke`. Expected: phases `creating → warming (progress) → ready`, `chat 200 …`, `deleted [ "smoke-qwen3-0.6b" ]`, session spend well under $0.10. Fix any RunPod payload mismatch discovered here (list envelope key, billing shape) in `http.ts` with a matching unit test.

- [ ] **Step 2: Create `examples/opencode.jsonc`**

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-runpod", // or an absolute path to a checkout of this repo
      "options": {
        "apiKey": "{env:RUNPOD_API_KEY}",
        "confirm": true,
        "idleTimeout": 120,
        "workersMax": 1,
        "maxHourlyRate": 3,
        "dataCenterIds": ["EU-RO-1", "EU-SE-1", "EU-CZ-1", "EU-NL-1"],
        "models": {
          "qwen3-coder-30b-a3b": {
            "name": "Qwen3 Coder 30B A3B FP8 (RunPod)",
            "hf": "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8",
            "gpu": "AMPERE_48",
            "context": 65536,
            "output": 8192,
            "quantization": "fp8"
          },
          "qwen3.8-27b-abliterated": {
            "name": "Qwen3.8 27B Abliterated (RunPod)",
            "hf": "huihui-ai/REPLACE-WITH-THE-SAFETENSORS-REPO", // GGUF-only repos do not run on vLLM
            "gpu": "AMPERE_80",
            "context": 98304,
            "output": 16384
          },
          "glm-4.7-flash-abliterated": {
            "name": "GLM 4.7 Flash Abliterated (RunPod)",
            "hf": "huihui-ai/REPLACE-WITH-THE-SAFETENSORS-REPO",
            "gpu": "AMPERE_80",
            "context": 65536,
            "output": 8192,
            "family": "glm-4.7"
          },
          "gpt-oss-20b": {
            "name": "gpt-oss 20B (RunPod)",
            "hf": "openai/gpt-oss-20b",
            "gpu": "AMPERE_48",
            "context": 65536,
            "output": 8192
          },
          "devstral-small-2-24b": {
            "name": "Devstral Small 2 24B (RunPod)",
            "hf": "mistralai/Devstral-Small-2-24B-Instruct-2512",
            "gpu": "AMPERE_80",
            "context": 65536,
            "output": 8192
          }
        }
      }
    }
  ]
}
```

- [ ] **Step 3: Create `README.md`**

```markdown
# opencode-runpod

opencode v2 plugin that runs your models on **RunPod Serverless** (vLLM worker), one endpoint per model,
created lazily on first use, scaled to zero when idle, and deleted when opencode shuts down.

- Pick `runpod/<model>` in `/models`. On the first request you get a **quote** (GPU, $/h, estimated cold start)
  and a confirm dialog. Nothing is created before you say yes.
- The endpoint uses `workers.min = 0`: after `idleTimeout` seconds without requests RunPod stops the worker and
  billing stops. The next request re-warms it (no dialog).
- Toasts show provisioning, cold-start progress, readiness, scale-down and deletion with the running spend; the
  footer shows `runpod <gpu> · warm|cold · $/h · ≈$spent`.
- `/runpod-status`, `/runpod-up <model>`, `/runpod-down [model|all]`.
- On opencode shutdown (plugin dispose) owned endpoints are deleted (`deleteOnExit`). Orphans from a crash are
  cleaned up at the next start.

## Install

```sh
opencode plugin add opencode-runpod        # or reference a local checkout by absolute path
export RUNPOD_API_KEY=...                  # from https://www.runpod.io/console/user/settings
```

Then add the plugin options to `opencode.json(c)` — see `examples/opencode.jsonc`. Models need **safetensors**
repos on Hugging Face (vLLM does not serve GGUF-only repos well); FP8/AWQ/GPTQ variants keep cold starts short.

## Options

| key | default | meaning |
|---|---|---|
| `apiKey` | env `RUNPOD_API_KEY` | RunPod API key (`{env:NAME}` / `{file:PATH}` accepted) |
| `hfToken` | env `HF_TOKEN` | for gated repos |
| `confirm` | `true` | ask before creating an endpoint |
| `confirmTimeoutSec` | `120` | unanswered dialog counts as declined |
| `idleTimeout` | `120` | seconds a worker stays warm (billed) after a request |
| `workersMax` | `1` | parallel workers per endpoint |
| `executionTimeoutSec` | `600` | per-request cap on RunPod |
| `coldStartTimeoutSec` | `600` | give up warming after this |
| `deleteOnExit` | `true` | delete owned endpoints on shutdown, remove stale ones on start |
| `adoptExisting` | `true` | reuse an `oc-runpod-*` endpoint whose config hash matches |
| `maxHourlyRate` | – | refuse provisioning above this $/h |
| `dataCenterIds` | `[]` | pin regions, e.g. `["EU-RO-1"]` |
| `minCudaVersion` | `"12.8"` | host CUDA floor |
| `workerImage` | `runpod/worker-v1-vllm:v2.27.2` | vLLM worker image |
| `flashboot` | `true` | RunPod FlashBoot |
| `models.<id>` | – | `hf`, `gpu` (pool id), `gpuCount`, `context`, `output`, `tools`, `family`, `toolParser`, `reasoningParser`, `quantization`, `weightsGb`, `env` |

GPU pools and static fallback prices: `AMPERE_16` $0.58 · `AMPERE_24` $0.69 · `ADA_24` $1.10 · `ADA_32_PRO` $1.58 ·
`AMPERE_48` $1.22 · `ADA_48_PRO` $1.75 · `AMPERE_80` $2.72 · `ADA_80_PRO` $4.79 · `BLACKWELL_96` $3.49 · `HOPPER_141` $5.93
(live prices come from RunPod's catalog when available).

## Cost model

You pay RunPod per second while a worker runs: cold start (image + weights load), your requests, and the
`idleTimeout` window after each request. Zero workers cost nothing. Endpoint records are kept in opencode's plugin
storage; the config hash `OPENCODE_RUNPOD_HASH` on each endpoint lets the plugin recognise and reuse or replace them.

## Caveats

- The first request after a cold start waits for the worker (minutes for 30B-class models). The request timeout is
  raised to 10 minutes for this provider.
- opencode runs a background service; `deleteOnExit` fires when the service disposes the plugin (`opencode service stop|restart`,
  location shutdown), not necessarily when you close the TUI. Scaled-to-zero endpoints cost $0 either way; use
  `/runpod-down` to remove one explicitly.
- Two opencode locations loading the plugin adopt the same endpoints by name; the last one out deletes them.

## Development

Hexagonal layout: `src/core` (domain + `EndpointService`, ports only), `src/adapters/driven` (RunPod, vLLM recipe,
Hugging Face, opencode storage/RPC, system), `src/adapters/driving` (opencode plugin, TUI, RPC contract).

```sh
npm install
npm run check          # tsc + node:test (includes the architecture rule test)
RUNPOD_API_KEY=... npm run smoke   # real endpoint, ~$0.05
```
Dev config: `.opencode/opencode.jsonc` loads this checkout with a tiny test model when opencode runs in this directory.
```

Adjust the caveat about TUI exit to what Task 15 step 7.8 observed.

- [ ] **Step 4: Typecheck, tests, commit**

Run: `npm run check`
```bash
git add scripts/smoke.ts README.md examples/opencode.jsonc
git commit -m "docs: README, example config and real-API smoke script"
```

- [ ] **Step 5: Install into the user's global opencode config (manual, user-owned file)**

Add to `~/.config/opencode/opencode.json` (JSON, no comments) a `plugins` entry pointing at this checkout, with the
user's real model set (start from `examples/opencode.jsonc`, replace the `REPLACE-WITH…` repos with real safetensors
repo ids or drop those models):

```json
"plugins": [
  {
    "package": "/Volumes/dev/projects/runpod-opencode",
    "options": {
      "apiKey": "{env:RUNPOD_API_KEY}",
      "confirm": true,
      "idleTimeout": 120,
      "maxHourlyRate": 3,
      "models": {
        "qwen3-coder-30b-a3b": { "name": "Qwen3 Coder 30B A3B FP8 (RunPod)", "hf": "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8", "gpu": "AMPERE_48", "context": 65536, "output": 8192, "quantization": "fp8" }
      }
    }
  }
]
```
Make sure `RUNPOD_API_KEY` is exported in the shell that starts opencode (or use `"apiKey": "{file:/path/to/key}"`),
then `opencode service restart`. `opencode models | grep runpod` must list the configured models from any directory.

---

## Verification items from the spec (§9) and where they are resolved

1. `ctx.session.synthetic` behaviour → Task 14 step 5 (decision rule with both code paths).
2. Local directory plugin loading (`index.ts`/`tui.ts`/`rpc.ts` at the root) → Task 14 step 3 (`opencode models`).
3. `{env:}` substitution in plugin options → handled either way by `resolveSecret` (Task 12).
4. Exact `Provider.Info` / `Model.Info` fields → Task 13 step 3 (tsc-guided, no blanket casts).
