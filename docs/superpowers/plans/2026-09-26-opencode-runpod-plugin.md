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
- Defaults (spec §4): `confirm true`, `confirmTimeoutSec 120`, `idleTimeout 120`, `workersMax 1`, `executionTimeoutSec 600`, `coldStartTimeoutSec 600`, `deleteOnExit false` (zero-worker endpoints cost $0; they are re-adopted next start), `adoptExisting true`, `minCudaVersion "12.8"`, `workerImage "runpod/worker-v1-vllm:v2.27.2"`, `flashboot true`.
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
│  ├─ model.ts          ModelConfig, Settings, findModel, MODEL_ID_PATTERN, ModelOverrides, idleTimeoutFor, applyOverrides, deriveModelID
│  ├─ endpoint.ts       Phase, WorkerRecipe, EndpointSpec, EndpointRecord, ENDPOINT_PREFIX, endpointName, modelIDFromName, specHash, specHashFor, buildEndpointSpec
│  ├─ quote.ts          PoolRate, Quote, DEFAULT_WEIGHTS_GB, FIT_FACTOR, fitsPool, estimateColdStartSec, idleWindowUsd, buildQuote
│  ├─ provision.ts      GpuOption, ProvisionProposal, ProvisionOverrides, ProvisionDecision, IDLE_TIMEOUT_CHOICES, PoolPricing, buildGpuOptions, buildProposal, gpuVariantsFor
│  ├─ spend-meter.ts    SpendMeter
│  └─ events.ts         StateEvent, NoticeLevel, WorkerCounts, ModelStatus, StatusReport
├─ src/core/ports/
│  ├─ compute-provider.ts  ComputeProviderPort, RemoteEndpoint, HealthSnapshot, ComputeError
│  ├─ price-catalog.ts  PriceCatalogPort        ├─ worker-recipe.ts  WorkerRecipePort      ├─ weights-info.ts  WeightsInfoPort
│  ├─ state-store.ts    StateStorePort          ├─ clock.ts          ClockPort             ├─ confirmation.ts  ConfirmationPort
│  ├─ notifier.ts       NotifierPort            ├─ logger.ts         LoggerPort            ├─ catalog-publisher.ts  CatalogPublisherPort, PublishedModel
│  └─ driving.ts        ModelRoutingPort, OperationsPort, AddModelInput, LifecyclePort
├─ src/core/application/endpoint-service.ts   EndpointService
├─ src/adapters/driven/runpod/   types.ts, http.ts (RunpodHttp, RunpodError), compute-provider.ts (RunpodComputeProvider), pools.ts (POOLS), price-catalog.ts (RunpodPriceCatalog)
├─ src/adapters/driven/vllm/     presets.ts (FAMILIES, inferFamily, parsersFor), recipe.ts (VllmWorkerRecipe, diskGb)
├─ src/adapters/driven/huggingface/weights-info.ts   fetchWeightsGb, HfWeightsInfo
├─ src/adapters/driven/opencode/ state-store.ts (OpencodeStateStore), notifier.ts (RpcNotifier), confirmation.ts (ConfirmBroker, RpcConfirmation), catalog-publisher.ts (OpencodeCatalogPublisher)
├─ src/adapters/driven/system/   clock.ts (SystemClock), logger.ts (ConsoleLogger)
├─ src/adapters/driving/rpc/     contract.ts (zod DTOs + RunpodRpc), format.ts
├─ src/adapters/driving/opencode/ config.ts (resolveSettings, parseOverrides), provider-catalog.ts, commands.ts, plugin.ts
├─ src/adapters/driving/tui/     choose.ts (provision dialog loop), toasts.ts, dashboard.ts (sidebar serverless dashboard), plugin.tsx
└─ test/  architecture.test.ts, fakes/{clock,store,compute,catalog,weights,recipe,confirmation,notifier,logger,publisher,fixtures}.ts, *.test.ts
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
  // matches `from "x"`, `from 'x'`, `import "x"` and dynamic `import("x")`
  for (const match of readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) specs.push(match[1]!)
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


### Task 2: Domain — pricing math, spend meter, model overrides, provision proposals

**Files:**
- Modify: `src/core/domain/model.ts` (add `idleTimeout`, `MODEL_ID_PATTERN`, `ModelOverrides`, `idleTimeoutFor`, `applyOverrides`, `deriveModelID`)
- Modify: `src/core/domain/endpoint.ts` (`buildEndpointSpec` uses the per-model idle timeout)
- Modify: `test/domain-endpoint.test.ts` (model literal gains `idleTimeout`; one new assertion)
- Create: `src/core/domain/quote.ts`, `src/core/domain/spend-meter.ts`, `src/core/domain/provision.ts`
- Test: `test/domain-model.test.ts`, `test/domain-quote.test.ts`, `test/domain-provision.test.ts`

**Interfaces:**
- Consumes: `ModelConfig`, `Settings`, `findModel` (Task 1).
- Produces (`model.ts`): `ModelConfig.idleTimeout: number | null`; `MODEL_ID_PATTERN`; `type ModelOverrides = Partial<Omit<ModelConfig, "id">>`; `idleTimeoutFor(model, settings): number`; `applyOverrides(model, overrides): ModelConfig`; `deriveModelID(hf): string`.
- Produces (`quote.ts`): `interface PoolRate { ratePerHour; source: "catalog" | "fallback"; vramGb: number | null; label }`, `interface Quote { modelID; hf; gpu; gpuLabel; gpuCount; ratePerHour; rateSource; weightsGb; estColdStartSec; idleTimeout; idleWindowUsd; warnings; blocked }`, `DEFAULT_WEIGHTS_GB = 60`, `FIT_FACTOR = 0.85`, `fitsPool(weightsGb, vramGb, gpuCount): boolean | null`, `estimateColdStartSec`, `idleWindowUsd`, `buildQuote({ model, settings, rate, weightsGb })`.
- Produces (`provision.ts`): `interface GpuOption { pool; label; ratePerHour; rateSource; vramGb; fits: boolean | null; estColdStartSec; current }`, `interface ProvisionProposal { quote; gpuOptions; idleTimeoutChoices }`, `interface ProvisionOverrides { gpu?; idleTimeout? }`, `type ProvisionDecision = { accepted: false } | { accepted: true; overrides: ProvisionOverrides }`, `IDLE_TIMEOUT_CHOICES`, `interface PoolPricing { pool; rate: PoolRate }`, `buildGpuOptions(model, pricing, weightsGb)`, `buildProposal({ quote, model, pricing, weightsGb })`, `gpuVariantsFor(model, pricing): string[]`.
- Produces (`spend-meter.ts`): `class SpendMeter { constructor(now); start(ratePerHour, at?); stop(at?); usd(at?); readonly running }`.

- [ ] **Step 1: Extend `src/core/domain/model.ts`**

Add the `idleTimeout` field to `ModelConfig` (after `weightsGb`) and append the helpers:
```ts
  weightsGb: number | null
  /** Per-model idle window in seconds; null → Settings.idleTimeout. */
  idleTimeout: number | null
  env: Record<string, string>
}
```
```ts
export const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/

/** Everything but the id may be changed at runtime (dialog, variants, /runpod-set). */
export type ModelOverrides = Partial<Omit<ModelConfig, "id">>

export function idleTimeoutFor(model: ModelConfig, settings: Settings): number {
  return model.idleTimeout ?? settings.idleTimeout
}

/** Returns a new config; `undefined` values mean "not overridden"; `env` is copied. */
export function applyOverrides(model: ModelConfig, overrides: ModelOverrides): ModelConfig {
  const next: Record<string, unknown> = { ...model }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue
    next[key] = key === "env" ? { ...(value as Record<string, string>) } : value
  }
  return next as unknown as ModelConfig
}

/** "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8" → "qwen3-coder-30b-a3b-instruct-fp8" */
export function deriveModelID(hf: string): string {
  const name = hf.split("/").pop() ?? hf
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 63)
    .replace(/[-._]+$/, "")
  if (!MODEL_ID_PATTERN.test(id)) throw new Error(`cannot derive a model id from "${hf}"`)
  return id
}
```

- [ ] **Step 2: Use the per-model idle timeout in `src/core/domain/endpoint.ts`**

Change the import and the `workers` line of `buildEndpointSpec`:
```ts
import { idleTimeoutFor, type ModelConfig, type Settings } from "./model.ts"
```
```ts
    workers: { min: 0, max: settings.workersMax, idleTimeoutSec: idleTimeoutFor(model, settings) },
```

- [ ] **Step 3: Update `test/domain-endpoint.test.ts`**

Add `idleTimeout: null,` to the `model` literal (after `weightsGb: null,`) and add this assertion at the end of the `buildEndpointSpec` test:
```ts
  assert.equal(buildEndpointSpec({ ...model, idleTimeout: 45 }, settings, recipe).workers.idleTimeoutSec, 45)
```

- [ ] **Step 4: Write the failing tests**

`test/domain-model.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { applyOverrides, deriveModelID, idleTimeoutFor, type ModelConfig, type Settings } from "../src/core/domain/model.ts"

const model: ModelConfig = { id: "m", name: "M", hf: "Qwen/Qwen3-8B", gpu: "AMPERE_48", gpuCount: 1, context: 32768, output: 8192, tools: true, family: null, toolParser: undefined, reasoningParser: undefined, quantization: null, weightsGb: null, idleTimeout: null, env: { A: "1" } }
const settings: Settings = { confirm: true, confirmTimeoutSec: 120, idleTimeout: 120, workersMax: 1, executionTimeoutSec: 600, coldStartTimeoutSec: 600, deleteOnExit: true, adoptExisting: true, maxHourlyRate: null, dataCenterIds: [], minCudaVersion: "12.8", workerImage: "img", flashboot: true, models: [model] }

test("idleTimeoutFor prefers the per-model value", () => {
  assert.equal(idleTimeoutFor(model, settings), 120)
  assert.equal(idleTimeoutFor({ ...model, idleTimeout: 30 }, settings), 30)
})

test("applyOverrides returns a new config, skips undefined, copies env", () => {
  const next = applyOverrides(model, { gpu: "AMPERE_80", toolParser: null, weightsGb: undefined, env: { B: "2" } })
  assert.equal(next.gpu, "AMPERE_80")
  assert.equal(next.toolParser, null)
  assert.equal(next.weightsGb, null)
  assert.deepEqual(next.env, { B: "2" })
  assert.deepEqual(model.env, { A: "1" })
  assert.equal(model.gpu, "AMPERE_48")
  assert.equal(applyOverrides(model, {}).id, "m")
})

test("deriveModelID lowercases the repo name and normalises separators", () => {
  assert.equal(deriveModelID("Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8"), "qwen3-coder-30b-a3b-instruct-fp8")
  assert.equal(deriveModelID("huihui-ai/Huihui-Qwen3.8-27B-abliterated"), "huihui-qwen3.8-27b-abliterated")
  assert.equal(deriveModelID("org/__Weird Name__"), "weird-name")
  assert.throws(() => deriveModelID("org/___"), /cannot derive a model id/)
})
```

`test/domain-quote.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_WEIGHTS_GB, buildQuote, estimateColdStartSec, fitsPool, idleWindowUsd, type PoolRate } from "../src/core/domain/quote.ts"
import { SpendMeter } from "../src/core/domain/spend-meter.ts"
import type { ModelConfig, Settings } from "../src/core/domain/model.ts"

const model: ModelConfig = { id: "m", name: "M", hf: "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8", gpu: "AMPERE_48", gpuCount: 2, context: 65536, output: 8192, tools: true, family: null, toolParser: undefined, reasoningParser: undefined, quantization: "fp8", weightsGb: null, idleTimeout: null, env: {} }
const settings: Settings = { confirm: true, confirmTimeoutSec: 120, idleTimeout: 120, workersMax: 1, executionTimeoutSec: 600, coldStartTimeoutSec: 600, deleteOnExit: true, adoptExisting: true, maxHourlyRate: null, dataCenterIds: [], minCudaVersion: "12.8", workerImage: "img", flashboot: true, models: [model] }
const catalogRate: PoolRate = { ratePerHour: 1.3, source: "catalog", vramGb: 48, label: "A6000/A40 48GB" }
const fallbackRate: PoolRate = { ratePerHour: 1.22, source: "fallback", vramGb: 48, label: "A6000/A40 48GB" }

test("cold start estimate, idle window math and fit check", () => {
  assert.equal(estimateColdStartSec(null), 180)
  assert.equal(estimateColdStartSec(30), 45 + 105)
  assert.equal(idleWindowUsd(1.2, 120), 0.04)
  assert.equal(DEFAULT_WEIGHTS_GB, 60)
  assert.equal(fitsPool(31.6, 48, 1), true)
  assert.equal(fitsPool(45, 48, 1), false)
  assert.equal(fitsPool(45, 48, 2), true)
  assert.equal(fitsPool(null, 48, 1), null)
  assert.equal(fitsPool(10, null, 1), null)
})

test("buildQuote multiplies by gpuCount, uses the per-model idle timeout and warns on fallback pricing", () => {
  const q = buildQuote({ model: { ...model, idleTimeout: 60 }, settings, rate: fallbackRate, weightsGb: 31.6 })
  assert.equal(q.modelID, "m")
  assert.equal(q.hf, model.hf)
  assert.equal(q.gpuLabel, "A6000/A40 48GB")
  assert.equal(q.gpuCount, 2)
  assert.equal(q.ratePerHour, 2.44)
  assert.equal(q.rateSource, "fallback")
  assert.equal(q.weightsGb, 31.6)
  assert.equal(q.estColdStartSec, estimateColdStartSec(31.6))
  assert.equal(q.idleTimeout, 60)
  assert.equal(q.idleWindowUsd, idleWindowUsd(2.44, 60))
  assert.equal(q.blocked, null)
  assert.ok(q.warnings.some((w) => /static/.test(w)))
  assert.equal(buildQuote({ model, settings, rate: fallbackRate, weightsGb: 31.6 }).idleTimeout, 120)
})

test("buildQuote warns when weights may not fit or size is unknown, and blocks above maxHourlyRate or without a price", () => {
  const tight = buildQuote({ model: { ...model, gpuCount: 1 }, settings: { ...settings, maxHourlyRate: 1.0 }, rate: catalogRate, weightsGb: 45 })
  assert.ok(tight.warnings.some((w) => /may not fit 48 GB/.test(w)))
  assert.match(tight.blocked ?? "", /\$1\.30\/h exceeds options\.maxHourlyRate \$1\.00/)
  const unknownSize = buildQuote({ model, settings, rate: catalogRate, weightsGb: null })
  assert.ok(unknownSize.warnings.some((w) => /size unknown/.test(w)))
  assert.equal(unknownSize.blocked, null)
  const unpriced = buildQuote({ model, settings, rate: { ratePerHour: 0, source: "fallback", vramGb: null, label: "AMPERE_48" }, weightsGb: 10 })
  assert.match(unpriced.blocked ?? "", /no price known for GPU pool "AMPERE_48"/)
})

test("SpendMeter accumulates only while running and can be stopped retroactively", () => {
  let now = 0
  const meter = new SpendMeter(() => now)
  assert.equal(meter.usd(), 0)
  meter.start(3.6) // $3.6/h = $0.001/s
  now = 10_000
  assert.equal(meter.running, true)
  assert.ok(Math.abs(meter.usd() - 0.01) < 1e-9)
  meter.stop(5_000)
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

`test/domain-provision.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import type { ModelConfig } from "../src/core/domain/model.ts"
import { IDLE_TIMEOUT_CHOICES, buildGpuOptions, buildProposal, gpuVariantsFor, type PoolPricing } from "../src/core/domain/provision.ts"
import { buildQuote, type PoolRate } from "../src/core/domain/quote.ts"
import type { Settings } from "../src/core/domain/model.ts"

const model: ModelConfig = { id: "m", name: "M", hf: "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8", gpu: "AMPERE_48", gpuCount: 1, context: 65536, output: 8192, tools: true, family: null, toolParser: undefined, reasoningParser: undefined, quantization: "fp8", weightsGb: null, idleTimeout: null, env: {} }
const settings: Settings = { confirm: true, confirmTimeoutSec: 120, idleTimeout: 120, workersMax: 1, executionTimeoutSec: 600, coldStartTimeoutSec: 600, deleteOnExit: true, adoptExisting: true, maxHourlyRate: null, dataCenterIds: [], minCudaVersion: "12.8", workerImage: "img", flashboot: true, models: [model] }
const rate = (ratePerHour: number, vramGb: number | null, label: string): PoolRate => ({ ratePerHour, source: "catalog", vramGb, label })
const pricing: PoolPricing[] = [
  { pool: "AMPERE_80", rate: rate(2.72, 80, "A100 80GB") },
  { pool: "AMPERE_16", rate: rate(0.58, 16, "A4000/A4500 16GB") },
  { pool: "AMPERE_48", rate: rate(1.22, 48, "A6000/A40 48GB") },
  { pool: "UNPRICED", rate: { ratePerHour: 0, source: "fallback", vramGb: null, label: "UNPRICED" } },
]

test("buildGpuOptions prices every pool for the model, flags fit and current, sorted by price, skipping unpriced pools", () => {
  const options = buildGpuOptions({ ...model, gpuCount: 2 }, pricing, 31.6)
  assert.deepEqual(options.map((o) => o.pool), ["AMPERE_16", "AMPERE_48", "AMPERE_80"])
  assert.deepEqual(options.map((o) => o.ratePerHour), [1.16, 2.44, 5.44])
  assert.deepEqual(options.map((o) => o.fits), [false, true, true])
  assert.deepEqual(options.map((o) => o.current), [false, true, false])
  assert.equal(options[1]!.label, "A6000/A40 48GB")
  assert.equal(options[1]!.vramGb, 48)
  assert.equal(options[1]!.rateSource, "catalog")
  assert.equal(options[1]!.estColdStartSec, 45 + Math.round(31.6 * 3.5))
  assert.deepEqual(buildGpuOptions(model, pricing, null).map((o) => o.fits), [null, null, null])
})

test("buildProposal bundles the quote, the options and the idle choices", () => {
  const quote = buildQuote({ model, settings, rate: pricing[2]!.rate, weightsGb: 31.6 })
  const proposal = buildProposal({ quote, model, pricing, weightsGb: 31.6 })
  assert.equal(proposal.quote, quote)
  assert.equal(proposal.gpuOptions.length, 3)
  assert.deepEqual(proposal.idleTimeoutChoices, [...IDLE_TIMEOUT_CHOICES])
  assert.deepEqual(IDLE_TIMEOUT_CHOICES, [30, 60, 120, 300, 600, 1800])
})

test("gpuVariantsFor lists pools with at least the current pool's VRAM, cheapest first", () => {
  assert.deepEqual(gpuVariantsFor(model, pricing), ["AMPERE_48", "AMPERE_80"])
  assert.deepEqual(gpuVariantsFor({ ...model, gpu: "AMPERE_16" }, pricing), ["AMPERE_16", "AMPERE_48", "AMPERE_80"])
  assert.deepEqual(gpuVariantsFor({ ...model, gpu: "AMPERE_80" }, pricing), ["AMPERE_80"])
  assert.deepEqual(gpuVariantsFor({ ...model, gpu: "UNKNOWN" }, pricing), ["AMPERE_16", "AMPERE_48", "AMPERE_80"])
})
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `quote.ts`, `spend-meter.ts`, `provision.ts` not found; `domain-model.test.ts` fails on missing exports; `tsc` would also fail on the `idleTimeout` literal until Step 1 lands.

- [ ] **Step 6: Implement `src/core/domain/quote.ts`**

```ts
import { idleTimeoutFor, type ModelConfig, type Settings } from "./model.ts"

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
/** Fraction of VRAM the weights may occupy; the rest is KV cache and activations. */
export const FIT_FACTOR = 0.85

/** Heuristic: ~45 s container/engine start + ~3.5 s per GB pulled and loaded. Unknown size → 3 min. */
export function estimateColdStartSec(weightsGb: number | null): number {
  return weightsGb === null ? 180 : Math.round(45 + weightsGb * 3.5)
}

export function idleWindowUsd(ratePerHour: number, idleTimeoutSec: number): number {
  return Math.round(((ratePerHour * idleTimeoutSec) / 3600) * 1e6) / 1e6
}

/** true/false when both sizes are known, null otherwise. */
export function fitsPool(weightsGb: number | null, vramGb: number | null, gpuCount: number): boolean | null {
  if (weightsGb === null || vramGb === null) return null
  return weightsGb <= vramGb * gpuCount * FIT_FACTOR
}

export function buildQuote(input: { model: ModelConfig; settings: Settings; rate: PoolRate; weightsGb: number | null }): Quote {
  const { model, settings, rate, weightsGb } = input
  const ratePerHour = Math.round(rate.ratePerHour * model.gpuCount * 1e4) / 1e4
  const idleTimeout = idleTimeoutFor(model, settings)
  const warnings: string[] = []
  let blocked: string | null = null
  if (rate.source === "fallback") warnings.push("price from the static table (live catalog unavailable)")
  if (weightsGb === null) warnings.push("weights size unknown; the cold start estimate is a guess")
  if (fitsPool(weightsGb, rate.vramGb, model.gpuCount) === false) {
    warnings.push(`weights ≈${weightsGb} GB may not fit ${rate.vramGb! * model.gpuCount} GB of VRAM`)
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
    idleTimeout,
    idleWindowUsd: idleWindowUsd(ratePerHour, idleTimeout),
    warnings,
    blocked,
  }
}
```

- [ ] **Step 7: Implement `src/core/domain/spend-meter.ts`**

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

- [ ] **Step 8: Implement `src/core/domain/provision.ts`**

```ts
import type { ModelConfig } from "./model.ts"
import { estimateColdStartSec, fitsPool, type PoolRate, type Quote } from "./quote.ts"

export interface GpuOption {
  pool: string
  label: string
  /** $/h for the whole worker (pool rate × gpuCount). */
  ratePerHour: number
  rateSource: "catalog" | "fallback"
  vramGb: number | null
  fits: boolean | null
  estColdStartSec: number
  current: boolean
}

/** What the user sees before an endpoint is created: the quote plus every alternative. */
export interface ProvisionProposal {
  quote: Quote
  gpuOptions: GpuOption[]
  idleTimeoutChoices: number[]
}

export interface ProvisionOverrides {
  gpu?: string
  idleTimeout?: number
}

export type ProvisionDecision = { accepted: false } | { accepted: true; overrides: ProvisionOverrides }

export const IDLE_TIMEOUT_CHOICES: readonly number[] = [30, 60, 120, 300, 600, 1800]

export interface PoolPricing {
  pool: string
  rate: PoolRate
}

const byPrice = (a: { ratePerHour: number; pool: string }, b: { ratePerHour: number; pool: string }) =>
  a.ratePerHour - b.ratePerHour || (a.pool < b.pool ? -1 : a.pool > b.pool ? 1 : 0)

export function buildGpuOptions(model: ModelConfig, pricing: readonly PoolPricing[], weightsGb: number | null): GpuOption[] {
  return pricing
    .filter((p) => p.rate.ratePerHour > 0)
    .map(({ pool, rate }) => ({
      pool,
      label: rate.label,
      ratePerHour: Math.round(rate.ratePerHour * model.gpuCount * 1e4) / 1e4,
      rateSource: rate.source,
      vramGb: rate.vramGb,
      fits: fitsPool(weightsGb, rate.vramGb, model.gpuCount),
      estColdStartSec: estimateColdStartSec(weightsGb),
      current: pool === model.gpu,
    }))
    .sort(byPrice)
}

export function buildProposal(input: { quote: Quote; model: ModelConfig; pricing: readonly PoolPricing[]; weightsGb: number | null }): ProvisionProposal {
  return {
    quote: input.quote,
    gpuOptions: buildGpuOptions(input.model, input.pricing, input.weightsGb),
    idleTimeoutChoices: [...IDLE_TIMEOUT_CHOICES],
  }
}

/** Variant pools for the model picker: at least the current pool's VRAM (all pools when unknown), cheapest first. */
export function gpuVariantsFor(model: ModelConfig, pricing: readonly PoolPricing[]): string[] {
  const floor = pricing.find((p) => p.pool === model.gpu)?.rate.vramGb ?? null
  return pricing
    .filter((p) => p.rate.ratePerHour > 0 && (p.pool === model.gpu || floor === null || (p.rate.vramGb ?? 0) >= floor))
    .map((p) => ({ pool: p.pool, ratePerHour: p.rate.ratePerHour }))
    .sort(byPrice)
    .map((p) => p.pool)
}
```

- [ ] **Step 9: Run tests and typecheck**

Run: `npm run check`
Expected: all pass (architecture test included — the new domain files import only `./model.ts` / `./quote.ts`).

- [ ] **Step 10: Commit**

```bash
git add src/core/domain test/domain-endpoint.test.ts test/domain-model.test.ts test/domain-quote.test.ts test/domain-provision.test.ts
git commit -m "feat(core): quote math, spend meter, model overrides and provision proposals"
```

---

### Task 3: Ports, test fakes, and `EndpointService.ensureReady` (proposal → decision → overrides → create → warm)

**Files:**
- Create: `src/core/ports/compute-provider.ts`, `price-catalog.ts`, `worker-recipe.ts`, `weights-info.ts`, `state-store.ts`, `clock.ts`, `confirmation.ts`, `notifier.ts`, `logger.ts`, `catalog-publisher.ts`
- Modify: `src/core/ports/driving.ts` (new signatures)
- Create: `src/core/application/endpoint-service.ts` (delete `src/core/application/.gitkeep`)
- Create: `test/fakes/clock.ts`, `store.ts`, `compute.ts`, `catalog.ts`, `weights.ts`, `recipe.ts`, `confirmation.ts`, `notifier.ts`, `logger.ts`, `publisher.ts`, `fixtures.ts`
- Test: `test/service-ensure-ready.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2 domain (`ModelConfig` incl. `idleTimeout`, `ModelOverrides`, `applyOverrides`, `idleTimeoutFor`, `buildEndpointSpec`, `EndpointRecord`, `Phase`, `StateEvent`, `Quote`, `PoolRate`, `buildQuote`, `DEFAULT_WEIGHTS_GB`, `SpendMeter`, `ProvisionProposal`, `ProvisionDecision`, `ProvisionOverrides`, `PoolPricing`, `buildProposal`, `gpuVariantsFor`).
- Produces (ports, exact names): `ComputeProviderPort` (`list, create, scaleToZero, delete, health, warmup, diagnostics, setIdleTimeout, billedUsd, inferenceBaseURL`), `RemoteEndpoint`, `HealthSnapshot`, `ComputeError` (`kind: "transient" | "fatal"`, `status: number | null`); `PriceCatalogPort`; `WorkerRecipePort`; `WeightsInfoPort`; `StateStorePort` (`get, set, remove, keys(prefix)`); `ClockPort`; `ConfirmationPort.ask(proposal): Promise<ProvisionDecision>`; `NotifierPort`; `LoggerPort`; `PublishedModel { config; variants }`, `CatalogPublisherPort.publish(models)`; `ModelRoutingPort.ensureReady(modelID, opts?: { skipConfirm?; gpu? })`; `AddModelInput { hf; gpu?; overrides? }`; `OperationsPort` (`status, up, down, add, set, remove, models`); `LifecyclePort`.
- Produces (application): `interface ServicePorts { compute: ComputeProviderPort | null; catalog; weights; recipe; store; clock; confirmation; notifier; publisher; logger }`; `class EndpointService implements ModelRoutingPort { constructor(settings, ports); ensureReady(modelID, opts?); phase(modelID) }` (the `gpu` option is accepted but acted on in Task 5); constants `IDLE_GRACE_MS = 15000`, `HEALTH_POLL_MS = 3000`, `WARMUP_RETRY_MS = 5000`; storage keys `endpoints/<id>`, `weights/<hf>`, `overrides/<id>`, `models/<id>` via `recordKey`, `weightsKey`, `overridesKey`, `modelKey`.
- Produces (fakes): `FakeClock` (`now/sleep/setTimer/clearTimer/advance(ms)/pending`), `flush()`, `InMemoryStateStore` (`data`), `FakeCompute` (`remote, created, calls, healthSnapshot, diagnosticsText, billed, failCreate, failDelete, finishWarmup(), failWarmup(err), pendingWarmups`, URLs `https://compute.test/<id>/v1`), `FakeCatalog` (`rates, fail, calls`), `FakeWeights(value)`, `FakeRecipe`, `ScriptedConfirmation(decisions)` (`asked: ProvisionProposal[]`) + `accept(overrides?)` / `decline`, `RecordingNotifier` (`events, notices, phases`), `RecordingLogger` (`lines`), `FakePublisher` (`published: PublishedModel[][]`, `latest`), `sampleModel()`, `sampleSettings()`, `harness(settingsOverrides?, { answers?, weights?, compute? })`.

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
  /** Changes the idle window of a live endpoint without recreating it. */
  setIdleTimeout(id: string, seconds: number): Promise<void>
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
  /** All stored keys starting with `prefix`, sorted. */
  keys(prefix: string): Promise<string[]>
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
import type { ProvisionDecision, ProvisionProposal } from "../domain/provision.ts"

export interface ConfirmationPort {
  /** Shows the proposal to the user; resolves with their decision (declined when unanswered). */
  ask(proposal: ProvisionProposal): Promise<ProvisionDecision>
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

`src/core/ports/catalog-publisher.ts`:
```ts
import type { ModelConfig } from "../domain/model.ts"

export interface PublishedModel {
  config: ModelConfig
  /** GPU pool ids offered as selectable variants of this model. */
  variants: string[]
}

/** Receives the effective model list whenever it changes (host re-registers the provider). */
export interface CatalogPublisherPort {
  publish(models: readonly PublishedModel[]): Promise<void>
}
```

Replace `src/core/ports/driving.ts`:
```ts
import type { StatusReport } from "../domain/events.ts"
import type { ModelConfig, ModelOverrides } from "../domain/model.ts"

/** Driving port used by the model.request hook: make the model reachable and return its inference base URL. */
export interface ModelRoutingPort {
  /** `gpu` is the pool id of the selected variant; when it differs from the effective pool it is applied as an override first. */
  ensureReady(modelID: string, opts?: { skipConfirm?: boolean; gpu?: string }): Promise<string>
}

export interface AddModelInput {
  hf: string
  gpu?: string
  overrides?: ModelOverrides
}

/** Driving port used by commands and RPC methods. */
export interface OperationsPort {
  status(): Promise<StatusReport>
  up(modelID: string): Promise<string>
  down(modelID?: string): Promise<string[]>
  add(input: AddModelInput): Promise<ModelConfig>
  set(modelID: string, overrides: ModelOverrides): Promise<ModelConfig>
  /** Runtime models are removed; static models have their overrides reset. */
  remove(modelID: string): Promise<"removed" | "reset">
  models(): readonly ModelConfig[]
}

/** Driving port used by the plugin lifecycle. */
export interface LifecyclePort {
  start(): Promise<void>
  stop(budgetMs?: number): Promise<void>
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
  /** When set, writes to matching keys fail (simulates a storage error). */
  failWrites: ((key: string) => boolean) | null = null
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined
  }
  async set(key: string, value: unknown): Promise<void> {
    if (this.failWrites?.(key)) throw new Error(`write failed: ${key}`)
    this.data.set(key, structuredClone(value))
  }
  async remove(key: string): Promise<void> {
    this.data.delete(key)
  }
  async keys(prefix: string): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort()
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
  /** When set, health() waits for this promise (simulates a slow poll in flight). */
  healthGate: Promise<void> | null = null
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
    if (this.healthGate) await this.healthGate
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

  async setIdleTimeout(id: string, seconds: number): Promise<void> {
    this.calls.push(`setIdleTimeout:${id}:${seconds}`)
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
import type { ProvisionDecision, ProvisionOverrides, ProvisionProposal } from "../../src/core/domain/provision.ts"
import type { ConfirmationPort } from "../../src/core/ports/confirmation.ts"

export const accept = (overrides: ProvisionOverrides = {}): ProvisionDecision => ({ accepted: true, overrides })
export const decline: ProvisionDecision = { accepted: false }

/** Answers in order; the last answer repeats. */
export class ScriptedConfirmation implements ConfirmationPort {
  answers: ProvisionDecision[]
  asked: ProvisionProposal[] = []
  constructor(answers: ProvisionDecision[] = [accept()]) {
    this.answers = [...answers]
  }
  async ask(proposal: ProvisionProposal): Promise<ProvisionDecision> {
    this.asked.push(proposal)
    return this.answers.length > 1 ? this.answers.shift()! : (this.answers[0] ?? accept())
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

`test/fakes/publisher.ts`:
```ts
import type { CatalogPublisherPort, PublishedModel } from "../../src/core/ports/catalog-publisher.ts"

export class FakePublisher implements CatalogPublisherPort {
  published: PublishedModel[][] = []
  async publish(models: readonly PublishedModel[]): Promise<void> {
    this.published.push(models.map((m) => ({ config: structuredClone(m.config), variants: [...m.variants] })))
  }
  get latest(): PublishedModel[] | undefined {
    return this.published.at(-1)
  }
}
```

`test/fakes/fixtures.ts`:
```ts
import { EndpointService, type ServicePorts } from "../../src/core/application/endpoint-service.ts"
import type { ModelConfig, Settings } from "../../src/core/domain/model.ts"
import type { ProvisionDecision } from "../../src/core/domain/provision.ts"
import { FakeCatalog } from "./catalog.ts"
import { FakeClock } from "./clock.ts"
import { FakeCompute } from "./compute.ts"
import { ScriptedConfirmation, accept } from "./confirmation.ts"
import { RecordingLogger } from "./logger.ts"
import { RecordingNotifier } from "./notifier.ts"
import { FakePublisher } from "./publisher.ts"
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
    idleTimeout: null,
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
    deleteOnExit: false,
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
  publisher: FakePublisher
  logger: RecordingLogger
  settings: Settings
  service: EndpointService
}

export function harness(
  settingsOverrides: Partial<Settings> = {},
  opts: { answers?: ProvisionDecision[]; weights?: number | null; compute?: boolean } = {},
): Harness {
  const settings = sampleSettings(settingsOverrides)
  const clock = new FakeClock()
  const compute = new FakeCompute()
  const catalog = new FakeCatalog()
  const weights = new FakeWeights(opts.weights === undefined ? 31.6 : opts.weights)
  const recipe = new FakeRecipe()
  const store = new InMemoryStateStore()
  const confirmation = new ScriptedConfirmation(opts.answers ?? [accept()])
  const notifier = new RecordingNotifier()
  const publisher = new FakePublisher()
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
    publisher,
    logger,
  }
  return { clock, compute, catalog, weights, recipe, store, confirmation, notifier, publisher, logger, settings, service: new EndpointService(settings, ports) }
}
```

- [ ] **Step 3: Write the failing test**

`test/service-ensure-ready.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { HEALTH_POLL_MS } from "../src/core/application/endpoint-service.ts"
import type { EndpointRecord } from "../src/core/domain/endpoint.ts"
import { flush } from "./fakes/clock.ts"
import { accept, decline } from "./fakes/confirmation.ts"
import { harness } from "./fakes/fixtures.ts"

test("happy path: quote → proposal → accept → create → warm → ready, returns the inference URL", async () => {
  const h = harness()
  const pending = h.service.ensureReady("m")
  await flush()
  assert.equal(h.service.phase("m"), "warming")
  assert.equal(h.confirmation.asked.length, 1)
  const proposal = h.confirmation.asked[0]!
  assert.equal(proposal.quote.gpuLabel, "A6000/A40 48GB")
  assert.equal(proposal.quote.ratePerHour, 1.22)
  assert.equal(proposal.quote.rateSource, "catalog")
  assert.equal(proposal.quote.weightsGb, 31.6)
  assert.equal(proposal.quote.idleTimeout, 120)
  assert.deepEqual(proposal.gpuOptions.map((o) => o.pool), ["AMPERE_16", "AMPERE_48", "AMPERE_80"])
  assert.deepEqual(proposal.gpuOptions.map((o) => o.fits), [false, true, true])
  assert.deepEqual(proposal.gpuOptions.map((o) => o.current), [false, true, false])
  assert.equal(proposal.idleTimeoutChoices.length, 6)
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
  assert.equal(h.publisher.published.length, 0) // nothing changed → no republish
})

test("accepting with overrides re-prices, provisions on the chosen pool, persists the overrides and republishes", async () => {
  const h = harness({}, { answers: [accept({ gpu: "AMPERE_80", idleTimeout: 60 })] })
  const pending = h.service.ensureReady("m")
  await flush()
  assert.equal(h.confirmation.asked.length, 1)
  assert.equal(h.confirmation.asked[0]!.quote.ratePerHour, 1.22)
  const spec = h.compute.created[0]!
  assert.equal(spec.gpu.pool, "AMPERE_80")
  assert.equal(spec.workers.idleTimeoutSec, 60)
  assert.deepEqual(await h.store.get("overrides/m"), { gpu: "AMPERE_80", idleTimeout: 60 })
  assert.deepEqual(h.publisher.latest?.map((m) => [m.config.id, m.config.gpu, m.variants]), [["m", "AMPERE_80", ["AMPERE_80"]]])
  h.compute.finishWarmup()
  await pending
  assert.equal(h.notifier.events.at(-1)!.ratePerHour, 2.72)
  assert.equal(h.notifier.events.at(-1)!.gpuLabel, "A100 80GB")
})

test("overrides equal to the current values are not persisted", async () => {
  const h = harness({}, { answers: [accept({ gpu: "AMPERE_48", idleTimeout: 120 })] })
  const pending = h.service.ensureReady("m")
  await flush()
  h.compute.finishWarmup()
  await pending
  assert.equal(await h.store.get("overrides/m"), undefined)
  assert.equal(h.publisher.published.length, 0)
})

test("an override that breaks maxHourlyRate or names an unknown pool is refused before anything is persisted", async () => {
  const capped = harness({ maxHourlyRate: 2.0 }, { answers: [accept({ gpu: "AMPERE_80" })] })
  await assert.rejects(capped.service.ensureReady("m"), /refusing to provision m: \$2\.72\/h exceeds options\.maxHourlyRate \$2\.00/)
  assert.equal(capped.compute.created.length, 0)
  assert.equal(await capped.store.get("overrides/m"), undefined)
  assert.equal(capped.service.phase("m"), "cold")
  const unknown = harness({}, { answers: [accept({ gpu: "NOPE" })] })
  await assert.rejects(unknown.service.ensureReady("m"), /unknown GPU pool "NOPE" \(known: AMPERE_16, AMPERE_48, AMPERE_80\)/)
  assert.equal(await unknown.store.get("overrides/m"), undefined)
  assert.equal(unknown.service.phase("m"), "cold")
  assert.deepEqual(unknown.notifier.phases, ["confirming", "cold"])
  const badIdle = harness({}, { answers: [accept({ idleTimeout: 0 })] })
  await assert.rejects(badIdle.service.ensureReady("m"), /idleTimeout must be an integer between 1 and 3600/)
  assert.equal(badIdle.service.phase("m"), "cold")
})

test("a health poll that resolves after warm-up finished does not revert ready to warming", async () => {
  const h = harness()
  let release: () => void = () => {}
  h.compute.healthGate = new Promise<void>((resolve) => {
    release = resolve
  })
  const pending = h.service.ensureReady("m")
  await flush()
  await h.clock.advance(HEALTH_POLL_MS) // the poller wakes up and parks inside health()
  assert.ok(h.compute.calls.includes("health:ep1"))
  h.compute.finishWarmup()
  await pending
  assert.equal(h.service.phase("m"), "ready")
  release()
  await flush()
  assert.equal(h.service.phase("m"), "ready")
  assert.equal(h.notifier.events.at(-1)!.phase, "ready")
})

test("a failed override write leaves the in-memory config untouched and resets to cold", async () => {
  const h = harness({}, { answers: [accept({ gpu: "AMPERE_80" })] })
  h.store.failWrites = (key) => key.startsWith("overrides/")
  await assert.rejects(h.service.ensureReady("m"), /write failed: overrides\/m/)
  assert.equal(h.compute.created.length, 0)
  assert.equal(h.service.phase("m"), "cold")
  assert.deepEqual(h.notifier.phases, ["confirming", "cold"])
  h.store.failWrites = null
  const retry = h.service.ensureReady("m")
  await flush()
  assert.equal(h.confirmation.asked[1]!.quote.gpu, "AMPERE_48") // memory still holds the configured pool
  assert.equal(h.compute.created[0]!.gpu.pool, "AMPERE_80")
  h.compute.finishWarmup()
  await retry
})

test("if the endpoint record cannot be stored, the created endpoint is kept and reused on retry", async () => {
  const h = harness()
  h.store.failWrites = (key) => key.startsWith("endpoints/")
  await assert.rejects(h.service.ensureReady("m"), /write failed: endpoints\/m/)
  assert.equal(h.compute.created.length, 1)
  assert.equal(h.service.phase("m"), "cold")
  h.store.failWrites = null
  const retry = h.service.ensureReady("m")
  await flush()
  assert.equal(h.compute.created.length, 1) // no second endpoint
  h.compute.finishWarmup()
  assert.equal(await retry, "https://compute.test/ep1/v1")
})

test("declined confirmation: nothing created, phase back to cold, actionable error", async () => {
  const h = harness({}, { answers: [decline] })
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
  assert.equal(h.confirmation.asked[0]!.quote.weightsGb, 12)
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
import { applyOverrides, idleTimeoutFor, type ModelConfig, type ModelOverrides, type Settings } from "../domain/model.ts"
import { buildProposal, gpuVariantsFor, type PoolPricing, type ProvisionOverrides } from "../domain/provision.ts"
import { DEFAULT_WEIGHTS_GB, buildQuote, type PoolRate, type Quote } from "../domain/quote.ts"
import { SpendMeter } from "../domain/spend-meter.ts"
import type { CatalogPublisherPort, PublishedModel } from "../ports/catalog-publisher.ts"
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
  publisher: CatalogPublisherPort
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

interface Priced {
  quote: Quote
  weightsGb: number | null
  rate: PoolRate
}

const round = (n: number) => Math.round(n * 1000) / 1000
export const recordKey = (modelID: string) => `endpoints/${modelID}`
export const weightsKey = (hf: string) => `weights/${hf}`
export const overridesKey = (modelID: string) => `overrides/${modelID}`
export const modelKey = (modelID: string) => `models/${modelID}`

export class EndpointService implements ModelRoutingPort {
  protected readonly settings: Settings
  protected readonly ports: ServicePorts
  protected readonly states = new Map<string, ModelState>()
  /** Models added at runtime are persisted whole under models/<id>; static models persist overrides/<id>. */
  protected readonly runtimeIDs = new Set<string>()

  constructor(settings: Settings, ports: ServicePorts) {
    this.settings = settings
    this.ports = ports
    for (const model of settings.models) this.newState(model)
  }

  phase(modelID: string): Phase {
    return this.state(modelID).phase
  }

  async ensureReady(modelID: string, opts: { skipConfirm?: boolean; gpu?: string } = {}): Promise<string> {
    const st = this.state(modelID)
    if (st.inflight) return st.inflight
    const run = this.run(st, opts).finally(() => {
      st.inflight = null
    })
    st.inflight = run
    return run
  }

  // ---- internals -------------------------------------------------------

  protected newState(model: ModelConfig): ModelState {
    const st: ModelState = {
      model,
      phase: "cold",
      detail: null,
      record: null,
      inflight: null,
      lastRequestAt: null,
      idleTimer: null,
      meter: new SpendMeter(() => this.ports.clock.now()),
      rate: null,
    }
    this.states.set(model.id, st)
    return st
  }

  protected state(modelID: string): ModelState {
    const st = this.states.get(modelID)
    if (!st) throw new Error(`RunPod: model "${modelID}" is not configured (options.models or /runpod-add)`)
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
      try {
        await this.provision(st, opts, compute)
      } catch (error) {
        // Every failure before the endpoint is usable ends in `cold` (paths that already reset are left alone).
        if (st.phase === "confirming" || st.phase === "creating") this.setPhase(st, "cold", `provisioning failed: ${(error as Error).message}`)
        throw error
      }
    }
    if (st.phase !== "ready") await this.warm(st, compute)
    this.touch(st)
    return compute.inferenceBaseURL(st.record!.endpointID)
  }

  /** Quote → (proposal → decision → validated, re-priced, persisted overrides) → create. */
  private async provision(st: ModelState, opts: { skipConfirm?: boolean }, compute: ComputeProviderPort): Promise<void> {
    let priced = await this.price(st.model)
    st.rate = priced.rate
    if (priced.quote.blocked) throw new Error(`RunPod: refusing to provision ${st.model.id}: ${priced.quote.blocked}`)
    if (this.settings.confirm && !opts.skipConfirm) {
      this.setPhase(st, "confirming", `waiting for confirmation · ${priced.quote.gpuLabel} · $${priced.quote.ratePerHour.toFixed(2)}/h`)
      const proposal = buildProposal({ quote: priced.quote, model: st.model, pricing: await this.pricing(), weightsGb: priced.weightsGb })
      const decision = await this.ports.confirmation.ask(proposal)
      if (!decision.accepted) {
        this.setPhase(st, "cold", "provisioning declined")
        throw new Error(
          `RunPod: provisioning of ${st.model.id} was declined or not confirmed within ${this.settings.confirmTimeoutSec}s. ` +
            `Run /runpod-up ${st.model.id} to provision without the dialog, or set options.confirm=false.`,
        )
      }
      const overrides = this.changedOverrides(st.model, decision.overrides)
      if (overrides) {
        this.validateOverrides(overrides)
        const candidate = applyOverrides(st.model, overrides)
        const repriced = await this.price(candidate)
        if (repriced.quote.blocked) {
          this.setPhase(st, "cold", `refused: ${repriced.quote.blocked}`)
          throw new Error(`RunPod: refusing to provision ${st.model.id}: ${repriced.quote.blocked}`)
        }
        await this.applyOverridesTo(st, overrides)
        priced = repriced
        st.rate = repriced.rate
      }
    }
    await this.create(st, priced, compute)
  }

  /** Only the parts of a dialog decision that differ from the effective config. */
  private changedOverrides(model: ModelConfig, chosen: ProvisionOverrides): ModelOverrides | null {
    const overrides: ModelOverrides = {}
    if (chosen.gpu !== undefined && chosen.gpu !== model.gpu) overrides.gpu = chosen.gpu
    if (chosen.idleTimeout !== undefined && chosen.idleTimeout !== idleTimeoutFor(model, this.settings)) overrides.idleTimeout = chosen.idleTimeout
    return Object.keys(overrides).length > 0 ? overrides : null
  }

  protected validateOverrides(overrides: ModelOverrides): void {
    const pools = this.ports.catalog.knownPools()
    if (overrides.gpu !== undefined && !pools.includes(overrides.gpu)) {
      throw new Error(`RunPod: unknown GPU pool "${overrides.gpu}" (known: ${pools.join(", ")})`)
    }
    const idle = overrides.idleTimeout
    if (idle !== undefined && idle !== null && (!Number.isInteger(idle) || idle < 1 || idle > 3600)) {
      throw new Error("RunPod: idleTimeout must be an integer between 1 and 3600 seconds")
    }
    if (overrides.gpuCount !== undefined && (!Number.isInteger(overrides.gpuCount) || overrides.gpuCount < 1 || overrides.gpuCount > 8)) {
      throw new Error("RunPod: gpuCount must be an integer between 1 and 8")
    }
    if (overrides.context !== undefined && (!Number.isInteger(overrides.context) || overrides.context < 1024)) {
      throw new Error("RunPod: context must be an integer ≥ 1024")
    }
    if (overrides.output !== undefined && (!Number.isInteger(overrides.output) || overrides.output < 256)) {
      throw new Error("RunPod: output must be an integer ≥ 256")
    }
  }

  /** Persists validated overrides, then applies them in memory (so a failed write changes nothing) and republishes the catalog. */
  protected async applyOverridesTo(st: ModelState, overrides: ModelOverrides): Promise<void> {
    const next = applyOverrides(st.model, overrides)
    if (this.runtimeIDs.has(st.model.id)) {
      await this.ports.store.set(modelKey(st.model.id), next)
    } else {
      const stored = (await this.ports.store.get<ModelOverrides>(overridesKey(st.model.id))) ?? {}
      await this.ports.store.set(overridesKey(st.model.id), { ...stored, ...overrides })
    }
    st.model = next
    st.rate = null
    await this.publish()
  }

  /** Every known pool priced; pools whose lookup fails are skipped. */
  protected async pricing(): Promise<PoolPricing[]> {
    const out: PoolPricing[] = []
    for (const pool of this.ports.catalog.knownPools()) {
      try {
        out.push({ pool, rate: await this.ports.catalog.rate(pool) })
      } catch (error) {
        this.ports.logger.warn("price lookup failed", { pool, error: String(error) })
      }
    }
    return out
  }

  /** Publishes the effective model list with GPU variants; never throws. */
  protected async publish(): Promise<void> {
    try {
      const pricing = await this.pricing()
      const models: PublishedModel[] = [...this.states.values()].map((st) => ({ config: st.model, variants: gpuVariantsFor(st.model, pricing) }))
      await this.ports.publisher.publish(models)
    } catch (error) {
      this.ports.logger.warn("catalog publish failed", { error: String(error) })
    }
  }

  protected async rateFor(model: ModelConfig): Promise<PoolRate> {
    try {
      return await this.ports.catalog.rate(model.gpu)
    } catch (error) {
      this.ports.logger.warn("price lookup failed", { pool: model.gpu, error: String(error) })
      return { ratePerHour: 0, source: "fallback", vramGb: null, label: model.gpu }
    }
  }

  private async price(model: ModelConfig): Promise<Priced> {
    const rate = await this.rateFor(model)
    const weightsGb = model.weightsGb ?? (await this.weightsGb(model))
    return { quote: buildQuote({ model, settings: this.settings, rate, weightsGb }), weightsGb, rate }
  }

  protected async weightsGb(model: ModelConfig): Promise<number | null> {
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

  private async create(st: ModelState, priced: Priced, compute: ComputeProviderPort): Promise<void> {
    this.setPhase(st, "creating", `creating endpoint on ${priced.quote.gpuLabel}`)
    const recipe = this.ports.recipe.recipe(st.model, this.settings, priced.weightsGb ?? DEFAULT_WEIGHTS_GB)
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
    if (!st.rate) st.rate = await this.rateFor(st.model)
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
        // Warm-up may have finished (ready) or failed (cold) while the call was in flight.
        if (signal.aborted || st.phase !== "warming") return
        this.setPhase(st, "warming", `workers: initializing ${h.initializing} · running ${h.running} · idle ${h.idle} · throttled ${h.throttled}`, this.elapsed(started))
      } catch (error) {
        this.ports.logger.warn("health poll failed", { endpointID, error: String(error) })
      }
    }
  }

  protected idleMs(st: ModelState): number {
    return idleTimeoutFor(st.model, this.settings) * 1000
  }

  protected touch(st: ModelState): void {
    st.lastRequestAt = this.ports.clock.now()
    if (st.idleTimer !== null) this.ports.clock.clearTimer(st.idleTimer)
    st.idleTimer = this.ports.clock.setTimer(() => this.onIdle(st), this.idleMs(st) + IDLE_GRACE_MS)
  }

  private onIdle(st: ModelState): void {
    st.idleTimer = null
    if (st.phase !== "ready" || st.lastRequestAt === null) return
    st.meter.stop(st.lastRequestAt + this.idleMs(st))
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
git commit -m "feat(core): ports, fakes and EndpointService provisioning with proposal-driven overrides"
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
  assert.notEqual(await h.store.get("endpoints/m"), undefined)
})

test("cold start timeout aborts, includes worker diagnostics, and a retry re-warms without re-confirming", async () => {
  const h = harness({ coldStartTimeoutSec: 60 })
  h.compute.diagnosticsText = "CUDA out of memory\nworker exited"
  const { pending } = await startWarming(h)
  const rejected = assert.rejects(pending, /timed out after 60s.*Worker log tail:\nCUDA out of memory\nworker exited/s)
  await h.clock.advance(60_000)
  await rejected
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

test("requests during the idle window keep the worker counted as warm; a per-model idle timeout is honoured", async () => {
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

  const short = harness({ models: [{ ...h.settings.models[0]!, idleTimeout: 30 }] })
  const s = await startWarming(short)
  short.compute.finishWarmup()
  await s.pending
  assert.equal(short.compute.created[0]!.workers.idleTimeoutSec, 30)
  await short.clock.advance(30_000 + IDLE_GRACE_MS)
  assert.equal(short.service.phase("m"), "idle")
})
```

- [ ] **Step 2: Run the tests**

Run: `npm test`
Expected: all pass. If one fails, fix `endpoint-service.ts` so the behaviour matches the test (the tests encode the spec), re-run, and describe the fix in the commit body.

- [ ] **Step 3: Commit**

```bash
git add test/service-warmup.test.ts src/core/application/endpoint-service.ts
git commit -m "test(core): characterize warm-up retries, timeouts, diagnostics and idle re-warm"
```

---

### Task 5: Lifecycle and runtime operations — `start`, `stop`, `down`, `status`, `add`, `set`, `remove`, `models`, variants

**Files:**
- Modify: `src/core/domain/events.ts` (add `WorkerCounts`, `ModelStatus.workers`)
- Modify: `src/core/application/endpoint-service.ts`
- Test: `test/service-lifecycle.test.ts`, `test/service-runtime-config.test.ts`
- Step 7 (fix round 1) also: Create `test/service-inflight-ops.test.ts`; Modify `src/core/ports/worker-recipe.ts` (doc comment), `test/fakes/compute.ts` (`failList`, `deleteGate`), `test/fakes/confirmation.ts` (`gate`)

**Interfaces:**
- Produces (`events.ts`): `interface WorkerCounts { initializing; running; idle; throttled }`; `ModelStatus.workers: WorkerCounts | null` (live counts from a best-effort health call; null when not provisioned or the call fails).
- Produces: `EndpointService implements ModelRoutingPort, OperationsPort, LifecyclePort` — `start()` (load persisted overrides + runtime models, reconcile remote endpoints, publish), `stop(budgetMs = 10000)`, `status()`, `up(modelID)`, `down(modelID?)`, `add(input)`, `set(modelID, overrides)`, `remove(modelID)`, `models()`; `ensureReady(modelID, { gpu })` applies a differing pool as an override before provisioning.

- [ ] **Step 1: Write the failing tests**

`test/service-lifecycle.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { BILLING_TTL_MS } from "../src/core/application/endpoint-service.ts"
import { specHashFor, type EndpointRecord } from "../src/core/domain/endpoint.ts"
import { flush } from "./fakes/clock.ts"
import { harness, sampleModel } from "./fakes/fixtures.ts"

function expectedHash(h: ReturnType<typeof harness>) {
  const model = h.settings.models[0]!
  return specHashFor(model, h.settings, h.recipe.recipe(model, h.settings, null))
}

async function warm(h: ReturnType<typeof harness>, modelID = "m") {
  const p = h.service.ensureReady(modelID)
  await flush()
  h.compute.finishWarmup()
  await p
}

test("start adopts a matching remote endpoint, stores a record, reports idle and publishes the catalog", async () => {
  const h = harness()
  h.compute.remote.push({ id: "epX", name: "oc-runpod-m", hash: expectedHash(h) })
  await h.service.start()
  assert.equal(h.service.phase("m"), "idle")
  const record = await h.store.get<EndpointRecord>("endpoints/m")
  assert.equal(record?.endpointID, "epX")
  assert.equal(record?.hash, expectedHash(h))
  assert.deepEqual(h.notifier.phases, ["idle"])
  assert.equal(h.compute.calls.filter((c) => c.startsWith("delete:")).length, 0)
  assert.deepEqual(h.publisher.latest?.map((m) => [m.config.id, m.variants]), [["m", ["AMPERE_48", "AMPERE_80"]]])
  const p = h.service.ensureReady("m") // adopted → warm without confirm or create
  await flush()
  assert.equal(h.confirmation.asked.length, 0)
  assert.equal(h.compute.created.length, 0)
  h.compute.finishWarmup()
  assert.equal(await p, "https://compute.test/epX/v1")
})

test("start replaces stale endpoints of configured models (hash mismatch, duplicates) and reports unknown ones as orphans", async () => {
  const h = harness()
  h.compute.remote.push({ id: "old", name: "oc-runpod-m", hash: "0000000000000000" })
  h.compute.remote.push({ id: "gone", name: "oc-runpod-removed-model", hash: expectedHash(h) })
  h.compute.remote.push({ id: "keep", name: "oc-runpod-m", hash: expectedHash(h) })
  h.compute.remote.push({ id: "dup", name: "oc-runpod-m", hash: expectedHash(h) })
  h.compute.remote.push({ id: "unrelated", name: "someone-elses-endpoint", hash: null })
  await h.service.start()
  const deleted = h.compute.calls.filter((c) => c.startsWith("delete:")).map((c) => c.slice(7)).sort()
  assert.deepEqual(deleted, ["dup", "old"])
  assert.equal((await h.store.get<EndpointRecord>("endpoints/m"))?.endpointID, "keep")
  assert.deepEqual((await h.service.status()).orphans, [{ id: "gone", name: "oc-runpod-removed-model" }])
})

test("start leaves a matching endpoint alone (as an orphan) when adoptExisting is false", async () => {
  const h = harness({ adoptExisting: false })
  h.compute.remote.push({ id: "epX", name: "oc-runpod-m", hash: expectedHash(h) })
  await h.service.start()
  assert.equal(h.service.phase("m"), "cold")
  assert.equal(h.compute.calls.filter((c) => c.startsWith("delete:")).length, 0)
  assert.deepEqual((await h.service.status()).orphans, [{ id: "epX", name: "oc-runpod-m" }])
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

test("start without a compute provider still loads persisted config and publishes", async () => {
  const h = harness({}, { compute: false })
  await h.service.start()
  assert.equal(h.compute.calls.length, 0)
  assert.equal(h.publisher.published.length, 1)
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
  assert.match(h.notifier.events.at(-1)!.detail ?? "", /deleted · ≈\$0\.01 this session/)
  assert.deepEqual(await h.service.down(), [])
  assert.deepEqual(h.notifier.phases.slice(-2), ["deleting", "cold"])
})

test("down without a model id deletes every owned endpoint; delete failures surface", async () => {
  const two = harness({ models: [sampleModel(), sampleModel({ id: "n", hf: "Qwen/Qwen3-8B", gpu: "AMPERE_16" })] })
  await warm(two, "m")
  await warm(two, "n")
  assert.deepEqual(await two.service.down(), ["m", "n"])
  const failing = harness()
  await warm(failing)
  failing.compute.failDelete = new Error("forbidden")
  await assert.rejects(failing.service.down("m"), /forbidden/)
  assert.equal(failing.service.phase("m"), "error")
})

test("stop deletes owned endpoints only when deleteOnExit is set (default off)", async () => {
  const on = harness({ deleteOnExit: true })
  await warm(on)
  await on.service.stop(10_000)
  assert.ok(on.compute.calls.includes("delete:ep1"))
  const off = harness()
  await warm(off)
  await off.service.stop(10_000)
  assert.equal(off.compute.calls.filter((c) => c.startsWith("delete:")).length, 0)
})

test("status reports phase, endpoint, rate, spend, billed, live workers and orphans; up() skips confirmation", async () => {
  const h = harness()
  h.compute.billed = 0.77
  const before = await h.service.status()
  assert.equal(before.models.length, 1)
  assert.equal(before.models[0]!.phase, "cold")
  assert.equal(before.models[0]!.endpointID, null)
  assert.equal(before.models[0]!.ratePerHour, 1.22)
  assert.equal(before.models[0]!.gpuLabel, "A6000/A40 48GB")
  assert.equal(before.models[0]!.billedUsd, null)
  assert.equal(before.models[0]!.workers, null)
  const p = h.service.up("m")
  await flush()
  assert.equal(h.confirmation.asked.length, 0)
  h.compute.finishWarmup()
  await p
  await h.clock.advance(60_000)
  h.compute.healthSnapshot = { initializing: 0, running: 1, idle: 0, throttled: 0 }
  const after = await h.service.status()
  const m = after.models[0]!
  assert.equal(m.phase, "ready")
  assert.equal(m.endpointID, "ep1")
  assert.equal(m.billedUsd, 0.77)
  assert.ok(m.spendUsd > 0)
  assert.equal(m.lastRequestAt, 0)
  assert.equal(m.gpuCount, 1)
  assert.deepEqual(m.workers, { initializing: 0, running: 1, idle: 0, throttled: 0 })
  // billed $ is cached for BILLING_TTL_MS; live worker counts are only fetched while warming/ready
  h.compute.billed = 1.5
  assert.equal((await h.service.status()).models[0]!.billedUsd, 0.77)
  await h.clock.advance(BILLING_TTL_MS)
  const later = (await h.service.status()).models[0]!
  assert.equal(later.phase, "idle")
  assert.equal(later.billedUsd, 1.5)
  assert.equal(later.workers, null)
})
```

`test/service-runtime-config.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { IDLE_GRACE_MS } from "../src/core/application/endpoint-service.ts"
import type { ModelConfig } from "../src/core/domain/model.ts"
import { flush } from "./fakes/clock.ts"
import { harness, sampleModel } from "./fakes/fixtures.ts"

async function warm(h: ReturnType<typeof harness>, modelID = "m", gpu?: string) {
  const p = h.service.ensureReady(modelID, gpu === undefined ? {} : { gpu })
  await flush()
  h.compute.finishWarmup()
  return p
}

test("start loads persisted overrides and runtime models, then publishes them with variants", async () => {
  const h = harness()
  await h.store.set("overrides/m", { gpu: "AMPERE_80" })
  const extra: ModelConfig = sampleModel({ id: "extra", hf: "Qwen/Qwen3-8B", gpu: "AMPERE_16", quantization: null })
  await h.store.set("models/extra", extra)
  await h.service.start()
  assert.deepEqual(h.service.models().map((m) => [m.id, m.gpu]), [["m", "AMPERE_80"], ["extra", "AMPERE_16"]])
  assert.deepEqual(h.publisher.latest?.map((m) => [m.config.id, m.variants]), [["m", ["AMPERE_80"]], ["extra", ["AMPERE_16", "AMPERE_48", "AMPERE_80"]]])
  assert.equal((await h.service.status()).models[0]!.gpuLabel, "A100 80GB")
})

test("add derives the id, picks the cheapest fitting pool from the weights, persists and publishes", async () => {
  const h = harness()
  const added = await h.service.add({ hf: "Qwen/Qwen3-8B" })
  assert.equal(added.id, "qwen3-8b")
  assert.equal(added.gpu, "AMPERE_48") // 31.6 GB: AMPERE_16 does not fit, AMPERE_48 is cheaper than AMPERE_80
  assert.equal(added.weightsGb, 31.6)
  assert.equal(added.name, "qwen3-8b (RunPod)")
  assert.equal(added.context, 32768)
  assert.deepEqual(await h.store.get<ModelConfig>("models/qwen3-8b"), added)
  assert.deepEqual(h.service.models().map((m) => m.id), ["m", "qwen3-8b"])
  assert.deepEqual(h.publisher.latest?.map((m) => m.config.id), ["m", "qwen3-8b"])
  await assert.rejects(h.service.add({ hf: "Qwen/Qwen3-8B" }), /already exists/)
  const explicit = await h.service.add({ hf: "org/Big-Model", gpu: "AMPERE_80", overrides: { context: 8192, idleTimeout: 60 } })
  assert.equal(explicit.gpu, "AMPERE_80")
  assert.equal(explicit.context, 8192)
  assert.equal(explicit.idleTimeout, 60)
  await assert.rejects(h.service.add({ hf: "org/Other", gpu: "NOPE" }), /unknown GPU pool "NOPE"/)
})

test("add refuses when the size is unknown or nothing fits", async () => {
  const unknown = harness({}, { weights: null })
  await assert.rejects(unknown.service.add({ hf: "org/Mystery" }), /weights unknown.*known: AMPERE_16, AMPERE_48, AMPERE_80/s)
  const huge = harness({}, { weights: 500 })
  await assert.rejects(huge.service.add({ hf: "org/Huge" }), /no known GPU pool fits ≈500 GB/)
})

test("set with a hash-changing key deletes the live endpoint and re-provisions on next use", async () => {
  const h = harness()
  await warm(h)
  const next = await h.service.set("m", { gpu: "AMPERE_80" })
  assert.equal(next.gpu, "AMPERE_80")
  assert.ok(h.compute.calls.includes("delete:ep1"))
  assert.equal(h.service.phase("m"), "cold")
  assert.match(h.notifier.notices.at(-1)!.message, /configuration of m changed.*re-provisioned on next use/)
  assert.deepEqual(await h.store.get("overrides/m"), { gpu: "AMPERE_80" })
  assert.deepEqual(h.publisher.latest?.[0]!.variants, ["AMPERE_80"])
  const p = h.service.ensureReady("m")
  await flush()
  assert.equal(h.confirmation.asked.length, 2)
  assert.equal(h.compute.created[1]!.gpu.pool, "AMPERE_80")
  h.compute.finishWarmup()
  await p
})

test("set with only idleTimeout patches the live endpoint and re-arms the idle timer", async () => {
  const h = harness()
  await warm(h)
  await h.service.set("m", { idleTimeout: 30 })
  assert.ok(h.compute.calls.includes("setIdleTimeout:ep1:30"))
  assert.equal(h.compute.calls.filter((c) => c.startsWith("delete:")).length, 0)
  assert.equal(h.service.phase("m"), "ready")
  await h.clock.advance(30_000 + IDLE_GRACE_MS)
  assert.equal(h.service.phase("m"), "idle")
  assert.deepEqual(await h.store.get("overrides/m"), { idleTimeout: 30 })
})

test("set validates values and merges with earlier overrides", async () => {
  const h = harness()
  await assert.rejects(h.service.set("m", { gpuCount: 0 }), /gpuCount must be an integer between 1 and 8/)
  await assert.rejects(h.service.set("m", { context: 100 }), /context must be an integer ≥ 1024/)
  await assert.rejects(h.service.set("m", { output: 10 }), /output must be an integer ≥ 256/)
  await assert.rejects(h.service.set("nope", { gpu: "AMPERE_16" }), /not configured/)
  await h.service.set("m", { gpu: "AMPERE_80" })
  await h.service.set("m", { idleTimeout: 300 })
  assert.deepEqual(await h.store.get("overrides/m"), { gpu: "AMPERE_80", idleTimeout: 300 })
  assert.equal(h.service.models()[0]!.idleTimeout, 300)
})

test("remove deletes a runtime model with its endpoint and resets a static model's overrides", async () => {
  const h = harness()
  const added = await h.service.add({ hf: "Qwen/Qwen3-8B" })
  await warm(h, added.id)
  assert.equal(await h.service.remove(added.id), "removed")
  assert.ok(h.compute.calls.includes("delete:ep1"))
  assert.equal(await h.store.get("models/qwen3-8b"), undefined)
  assert.deepEqual(h.service.models().map((m) => m.id), ["m"])
  await assert.rejects(h.service.remove(added.id), /not configured/)

  await h.service.set("m", { gpu: "AMPERE_80" })
  await warm(h) // ep2 on AMPERE_80
  assert.equal(await h.service.remove("m"), "reset")
  assert.equal(h.service.models()[0]!.gpu, "AMPERE_48")
  assert.equal(await h.store.get("overrides/m"), undefined)
  assert.ok(h.compute.calls.includes("delete:ep2"))
  assert.equal(h.service.phase("m"), "cold")
})

test("a variant pool passed to ensureReady is applied as an override before provisioning", async () => {
  const h = harness()
  const url = await warm(h, "m", "AMPERE_80")
  assert.equal(url, "https://compute.test/ep1/v1")
  assert.equal(h.confirmation.asked[0]!.quote.gpu, "AMPERE_80")
  assert.equal(h.confirmation.asked[0]!.quote.ratePerHour, 2.72)
  assert.equal(h.compute.created[0]!.gpu.pool, "AMPERE_80")
  assert.deepEqual(await h.store.get("overrides/m"), { gpu: "AMPERE_80" })

  const same = harness()
  await warm(same, "m", "AMPERE_48")
  assert.equal(await same.store.get("overrides/m"), undefined)

  const switching = harness()
  await warm(switching, "m") // ep1 on AMPERE_48
  await warm(switching, "m", "AMPERE_16") // variant → set → delete ep1 → confirm → ep2
  assert.ok(switching.compute.calls.includes("delete:ep1"))
  assert.equal(switching.compute.created[1]!.gpu.pool, "AMPERE_16")
  assert.equal(switching.confirmation.asked.length, 2)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `start`, `down`, `stop`, `status`, `up`, `add`, `set`, `remove`, `models` are not functions.

- [ ] **Step 3: Add `WorkerCounts` to `src/core/domain/events.ts`**

Insert before `ModelStatus` and add the field at the end of `ModelStatus`:
```ts
/** Live worker counts of a provisioned endpoint (running workers are the ones being billed). */
export interface WorkerCounts {
  initializing: number
  running: number
  idle: number
  throttled: number
}
```
```ts
  lastRequestAt: number | null
  /** From a best-effort health call; null when not provisioned or the call failed. */
  workers: WorkerCounts | null
}
```

- [ ] **Step 4: Add the lifecycle and runtime-config methods to `EndpointService`**

Change the imports and the class declaration:
```ts
import { buildEndpointSpec, modelIDFromName, specHashFor, type EndpointRecord, type Phase } from "../domain/endpoint.ts"
import type { ModelStatus, StateEvent, StatusReport, WorkerCounts } from "../domain/events.ts"
import { applyOverrides, deriveModelID, findModel, idleTimeoutFor, type ModelConfig, type ModelOverrides, type Settings } from "../domain/model.ts"
import { buildProposal, gpuVariantsFor, type PoolPricing, type ProvisionOverrides } from "../domain/provision.ts"
import { DEFAULT_WEIGHTS_GB, buildQuote, fitsPool, type PoolRate, type Quote } from "../domain/quote.ts"
import type { AddModelInput, LifecyclePort, ModelRoutingPort, OperationsPort } from "../ports/driving.ts"
// ...
export class EndpointService implements ModelRoutingPort, OperationsPort, LifecyclePort {
  private orphans: { id: string; name: string }[] = []
```

Replace `ensureReady` so a differing variant pool is applied first:
```ts
  async ensureReady(modelID: string, opts: { skipConfirm?: boolean; gpu?: string } = {}): Promise<string> {
    const st = this.state(modelID)
    if (st.inflight) return st.inflight
    const run = (async () => {
      if (opts.gpu !== undefined && opts.gpu !== st.model.gpu) await this.set(modelID, { gpu: opts.gpu })
      return this.run(st, opts)
    })().finally(() => {
      st.inflight = null
    })
    st.inflight = run
    return run
  }
```

Replace `touch` with `touch` + `armIdle` (so `set` can re-arm without moving `lastRequestAt`):
```ts
  protected touch(st: ModelState): void {
    st.lastRequestAt = this.ports.clock.now()
    this.armIdle(st)
  }

  private armIdle(st: ModelState): void {
    if (st.idleTimer !== null) this.ports.clock.clearTimer(st.idleTimer)
    if (st.lastRequestAt === null) return
    const due = st.lastRequestAt + this.idleMs(st) + IDLE_GRACE_MS - this.ports.clock.now()
    st.idleTimer = this.ports.clock.setTimer(() => this.onIdle(st), Math.max(0, due))
  }
```

Add these methods after `ensureReady`:
```ts
  up(modelID: string): Promise<string> {
    return this.ensureReady(modelID, { skipConfirm: true })
  }

  models(): readonly ModelConfig[] {
    return [...this.states.values()].map((st) => st.model)
  }

  /** Load persisted runtime config, reconcile remote endpoints, publish the catalog. */
  async start(): Promise<void> {
    for (const st of this.states.values()) {
      const stored = await this.ports.store.get<ModelOverrides>(overridesKey(st.model.id))
      if (stored && Object.keys(stored).length > 0) st.model = applyOverrides(st.model, stored)
    }
    for (const key of await this.ports.store.keys("models/")) {
      const config = await this.ports.store.get<ModelConfig>(key)
      if (!config || this.states.has(config.id)) continue
      this.newState(config)
      this.runtimeIDs.add(config.id)
    }
    const compute = this.ports.compute
    if (compute) {
      this.orphans = []
      const remote = await compute.list()
      const byId = new Map(remote.map((ep) => [ep.id, ep] as const))
      for (const st of this.states.values()) {
        const stored = await this.ports.store.get<EndpointRecord>(recordKey(st.model.id))
        if (!stored) continue
        const ep = byId.get(stored.endpointID)
        if (ep && ep.hash === this.expectedHash(st.model)) {
          st.record = stored
          st.rate = await this.rateFor(st.model)
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
        const matches = st !== undefined && ep.hash !== null && ep.hash === this.expectedHash(st.model)
        if (st && !st.record && this.settings.adoptExisting && matches) {
          st.record = { endpointID: ep.id, name: ep.name, modelID, gpu: st.model.gpu, gpuCount: st.model.gpuCount, hash: ep.hash!, createdAt: this.ports.clock.now(), spendUsd: 0 }
          await this.ports.store.set(recordKey(modelID), st.record)
          st.rate = await this.rateFor(st.model)
          this.setPhase(st, "idle", "adopted existing endpoint")
          continue
        }
        // Ours (a configured model) but stale — different config or a duplicate: it would be replaced on next use anyway.
        const stale = st !== undefined && (!matches || st.record !== null)
        if (stale) {
          try {
            await compute.delete(ep.id)
            this.ports.logger.info("deleted stale endpoint", { id: ep.id, name: ep.name })
            continue
          } catch (error) {
            this.ports.logger.warn("failed to delete stale endpoint", { id: ep.id, error: String(error) })
          }
        }
        // Unknown model (removed from config, or another opencode location's): never deleted automatically.
        this.orphans.push({ id: ep.id, name: ep.name })
      }
    }
    await this.publish()
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
      st.rate = await this.rateFor(st.model)
      let billedUsd: number | null = null
      let workers: WorkerCounts | null = null
      if (st.record && this.ports.compute) {
        billedUsd = await this.billedFor(st.record.endpointID)
        // Live counts only matter (and only cost an API call) while a worker may be running.
        if (st.phase === "warming" || st.phase === "ready") workers = await this.ports.compute.health(st.record.endpointID).catch(() => null)
      }
      models.push({
        modelID: st.model.id,
        phase: st.phase,
        detail: st.detail,
        spendUsd: round(st.meter.usd()),
        ratePerHour: this.hourly(st),
        gpu: st.model.gpu,
        gpuLabel: st.rate.label,
        endpointID: st.record?.endpointID ?? null,
        gpuCount: st.model.gpuCount,
        billedUsd,
        lastRequestAt: st.lastRequestAt,
        workers,
      })
    }
    return { models, orphans: [...this.orphans] }
  }

  async add(input: AddModelInput): Promise<ModelConfig> {
    const id = deriveModelID(input.hf)
    if (this.states.has(id)) throw new Error(`RunPod: model "${id}" already exists (use /runpod-set ${id} key=value to change it)`)
    const pools = this.ports.catalog.knownPools()
    const draft: ModelConfig = {
      id,
      name: `${id} (RunPod)`,
      hf: input.hf,
      gpu: input.gpu ?? "",
      gpuCount: 1,
      context: 32768,
      output: 8192,
      tools: true,
      family: null,
      toolParser: undefined,
      reasoningParser: undefined,
      quantization: null,
      weightsGb: null,
      idleTimeout: null,
      env: {},
    }
    const config = applyOverrides(draft, input.overrides ?? {})
    if (config.gpu === "") {
      const weightsGb = config.weightsGb ?? (await this.weightsGb(config))
      if (weightsGb === null) {
        throw new Error(`RunPod: cannot size ${input.hf} (weights unknown); pass a GPU pool explicitly (known: ${pools.join(", ")})`)
      }
      const fitting = (await this.pricing())
        .filter((p) => p.rate.ratePerHour > 0 && fitsPool(weightsGb, p.rate.vramGb, config.gpuCount) === true)
        .sort((a, b) => a.rate.ratePerHour - b.rate.ratePerHour)
      if (fitting.length === 0) {
        throw new Error(`RunPod: no known GPU pool fits ≈${weightsGb} GB of weights with gpuCount ${config.gpuCount}; pass a pool and gpuCount explicitly`)
      }
      config.gpu = fitting[0]!.pool
      config.weightsGb = weightsGb
    }
    this.validateOverrides({ gpu: config.gpu, gpuCount: config.gpuCount, context: config.context, output: config.output, idleTimeout: config.idleTimeout })
    this.newState(config)
    this.runtimeIDs.add(id)
    await this.ports.store.set(modelKey(id), config)
    await this.publish()
    return config
  }

  async set(modelID: string, overrides: ModelOverrides): Promise<ModelConfig> {
    const st = this.state(modelID)
    this.validateOverrides(overrides)
    const next = applyOverrides(st.model, overrides)
    const record = st.record
    if (record) {
      if (this.expectedHash(st.model) !== this.expectedHash(next)) {
        this.ports.notifier.notice("info", `RunPod: configuration of ${modelID} changed; endpoint ${record.endpointID} is deleted and will be re-provisioned on next use.`)
        await this.down(modelID)
      } else if (idleTimeoutFor(next, this.settings) !== idleTimeoutFor(st.model, this.settings)) {
        await this.compute().setIdleTimeout(record.endpointID, idleTimeoutFor(next, this.settings))
      }
    }
    await this.applyOverridesTo(st, overrides)
    if (st.phase === "ready") this.armIdle(st)
    return st.model
  }

  async remove(modelID: string): Promise<"removed" | "reset"> {
    const st = this.state(modelID)
    if (this.runtimeIDs.has(modelID)) {
      if (st.record) await this.down(modelID)
      if (st.idleTimer !== null) this.ports.clock.clearTimer(st.idleTimer)
      this.states.delete(modelID)
      this.runtimeIDs.delete(modelID)
      await this.ports.store.remove(modelKey(modelID))
      await this.publish()
      return "removed"
    }
    const base = findModel(this.settings, modelID)!
    if (st.record && this.expectedHash(st.model) !== this.expectedHash(base)) await this.down(modelID)
    st.model = base
    st.rate = null
    await this.ports.store.remove(overridesKey(modelID))
    await this.publish()
    return "reset"
  }

  private expectedHash(model: ModelConfig): string {
    return specHashFor(model, this.settings, this.ports.recipe.recipe(model, this.settings, null))
  }

  /** Billing data changes slowly and the dashboard polls status(); cache it per endpoint. */
  private async billedFor(endpointID: string): Promise<number | null> {
    const now = this.ports.clock.now()
    const cached = this.billedCache.get(endpointID)
    if (cached && now - cached.at < BILLING_TTL_MS) return cached.usd
    const usd = await this.compute().billedUsd(endpointID).catch(() => null)
    this.billedCache.set(endpointID, { at: now, usd })
    return usd
  }
```

Add the constant next to the other exported constants and the cache field next to `orphans`:
```ts
/** How long a billed-$ lookup is reused by status(). */
export const BILLING_TTL_MS = 5 * 60_000
```
```ts
  private readonly billedCache = new Map<string, { at: number; usd: number | null }>()
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm run check`
Expected: pass. (`expectedHash` matches the test helper because both call the recipe with `weightsGb = null` and the hash excludes disk. In the "variant" test the first `warm` on AMPERE_80 asks once because `set` happens before `run`.)

- [ ] **Step 6: Commit**

```bash
git add src/core/domain/events.ts src/core/application/endpoint-service.ts test/service-lifecycle.test.ts test/service-runtime-config.test.ts
git commit -m "feat(core): reconcile on start, teardown, status with live workers, and runtime model configuration (add/set/remove, variants)"
```

- [ ] **Step 7: Fix round 1 (post-review) — in-flight operations, best-effort teardown, sticky metering rate**

Applied after Task 5's review (reviewer findings I1–I5, M1/M2/M4/M5 and controller rulings); binding for anyone re-implementing Task 5. Write the tests in H first, run RED with `node --test --test-timeout=5000 test/service-inflight-ops.test.ts test/service-lifecycle.test.ts test/service-runtime-config.test.ts` (some RED tests wait on promises that never settle), then implement A–G and run `npm run check`.

#### A. Shared helpers and constants

```ts
/** Abort reason used when an endpoint is deleted during its cold start. */
const CANCELLED = Symbol("cancelled")

/** $/h for `gpuCount` GPUs at `rate`, rounded to 4 decimals (0 when the price is unknown). */
const hourlyRate = (rate: PoolRate | null, gpuCount: number) => Math.round((rate?.ratePerHour ?? 0) * gpuCount * 1e4) / 1e4
```

`hourly(st)` becomes `return hourlyRate(st.rate, st.model.gpuCount)`.

`ModelState` gains `warmAbort: AbortController | null`, and `newState()` initialises it to `null`.

Add these methods:

```ts
  private busy(st: ModelState): Error {
    return new Error(`RunPod: ${st.model.id} is busy (${st.phase}); try again when the current operation finishes.`)
  }

  /** Throws when another operation owns the model: a request in flight or a teardown in progress. */
  private ensureNotBusy(st: ModelState): void {
    if (st.inflight !== null || st.phase === "deleting") throw this.busy(st)
  }

  /** The pool's catalog rate, or null when unknown. A failed lookup is never cached as the metering rate (I3). */
  private async knownRate(model: ModelConfig): Promise<PoolRate | null> {
    const rate = await this.rateFor(model)
    return rate.ratePerHour > 0 ? rate : null
  }
```

#### B. Cancelling a cold start and the `deleting` phase (R-A, S2)

Rules:
- **`down(id)` while the model is `warming`:** abort the warm-up, then delete as usual. The pending `ensureReady` rejects with `RunPod: cold start of <id> was cancelled: endpoint <endpointID> is being deleted.` There are no diagnostics and no extra `cold` event.
- **Busy states.** A model is busy when either:
  - its phase is `deleting`; or
  - it has a request in flight and its phase is anything other than `warming`.
- **Who rejects on busy:**
  - `down(id)` rejects with `busy`, and `down()` for all skips the model;
  - `set()` and `remove()` reject whenever `ensureNotBusy` fails;
  - `ensureReady()` rejects while the phase is `deleting`.
- **Variant pool.** `ensureReady(id, { gpu })` applies a differing variant pool through the unguarded `reconfigure()` (section D). It must not depend on the order in which `st.inflight` is assigned.

Edits:
- **`warm()`:**
  - Put `st.warmAbort = controller` directly after `const controller = new AbortController()`, in the same synchronous block.
  - After the retry loop, before `st.meter.stop(...)`, add:
    ```ts
          if (controller.signal.reason === CANCELLED) {
            // teardown() owns the phase, meter and record from here on.
            throw new Error(`RunPod: cold start of ${st.model.id} was cancelled: endpoint ${record.endpointID} is being deleted.`)
          }
    ```
  - In `finally`, after `controller.abort()`, add `if (st.warmAbort === controller) st.warmAbort = null`.
  - Change `if (!st.rate) st.rate = await this.rateFor(st.model)` to `if (!st.rate) st.rate = await this.knownRate(st.model)`.
  - In the failure path, guard the phase write, because a `down()` that lands while diagnostics are being fetched owns the phase (the same pattern as the pollHealth re-check): `if (st.phase === "warming") this.setPhase(st, "cold", `cold start ${reason}`)`.
- **`run()`:** replace the tail with:
  ```ts
      if (st.phase !== "ready") await this.warm(st, compute)
      const record = st.record
      // teardown() may have deleted the endpoint while this request was starting it.
      if (!record) throw new Error(`RunPod: ${st.model.id} was torn down while starting; retry.`)
      this.touch(st)
      return compute.inferenceBaseURL(record.endpointID)
  ```
- **`ensureReady()`:**
  ```ts
    async ensureReady(modelID: string, opts: { skipConfirm?: boolean; gpu?: string } = {}): Promise<string> {
      const st = this.state(modelID)
      if (st.inflight) return st.inflight
      if (st.phase === "deleting") throw this.busy(st)
      const run = (async () => {
        if (opts.gpu !== undefined && opts.gpu !== st.model.gpu) await this.reconfigure(st, { gpu: opts.gpu })
        return this.run(st, opts)
      })().finally(() => {
        st.inflight = null
      })
      st.inflight = run
      return run
    }
  ```

#### C. `down()` is best effort for all models (I2, spec §5.2), and `teardown()` does the per-model work (M4)

```ts
  async down(modelID?: string): Promise<string[]> {
    const compute = this.compute()
    const targets = modelID === undefined ? [...this.states.values()] : [this.state(modelID)]
    const deleted: string[] = []
    const failures: string[] = []
    for (const st of targets) {
      // Another operation owns the model — except a cold start, which teardown() cancels.
      if (st.phase === "deleting" || (st.inflight !== null && st.phase !== "warming")) {
        if (modelID !== undefined) throw this.busy(st)
        continue
      }
      if (!st.record) continue
      try {
        await this.teardown(st, compute)
        deleted.push(st.model.id)
      } catch (error) {
        if (modelID !== undefined) throw error
        failures.push(`${st.model.id} (${(error as Error).message})`)
      }
    }
    if (failures.length > 0) {
      const done = deleted.length > 0 ? `; deleted ${deleted.join(", ")}` : ""
      throw new Error(`RunPod: could not delete ${failures.join(", ")}${done}`)
    }
    return deleted
  }

  /** Scales the endpoint to zero and deletes it, cancelling its cold start if one is running. Callers check busy-ness. */
  private async teardown(st: ModelState, compute: ComputeProviderPort): Promise<void> {
    const record = st.record!
    this.setPhase(st, "deleting", `deleting ${record.endpointID}`)
    st.warmAbort?.abort(CANCELLED)
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
    this.billedCache.delete(record.endpointID)
    await this.ports.store.remove(recordKey(st.model.id))
    this.setPhase(st, "cold", `deleted · ≈$${st.meter.usd().toFixed(2)} this session`)
  }
```

`stop()` must clear its budget timer when cleanup wins the race (M2):

```ts
  async stop(budgetMs = 10_000): Promise<void> {
    if (!this.settings.deleteOnExit) return
    let timer: unknown = null
    const budget = new Promise<void>((resolve) => {
      timer = this.ports.clock.setTimer(resolve, budgetMs)
    })
    try {
      await Promise.race([
        this.down().catch((error: unknown) => {
          this.ports.logger.warn("shutdown cleanup failed", { error: String(error) })
        }),
        budget,
      ])
    } finally {
      this.ports.clock.clearTimer(timer)
    }
  }
```

#### D. `set()`, `reconfigure()` and `syncEndpoint()` (R-A, S3, M5), and `remove()` (I1, M1)

```ts
  async set(modelID: string, overrides: ModelOverrides): Promise<ModelConfig> {
    const st = this.state(modelID)
    this.ensureNotBusy(st)
    return this.reconfigure(st, overrides)
  }

  /** set() without the busy guard: ensureReady applies a variant pool through it from inside its own request. */
  private async reconfigure(st: ModelState, overrides: ModelOverrides): Promise<ModelConfig> {
    this.validateOverrides(overrides)
    await this.syncEndpoint(st, applyOverrides(st.model, overrides))
    await this.applyOverridesTo(st, overrides)
    if (st.phase === "ready") this.armIdle(st)
    return st.model
  }

  /** Brings a live endpoint in line with `next`: a spec-hash change deletes it (re-provisioned on next use), an idle-only change patches it. */
  private async syncEndpoint(st: ModelState, next: ModelConfig): Promise<void> {
    const record = st.record
    if (!record) return
    if (this.expectedHash(st.model) !== this.expectedHash(next)) {
      await this.teardown(st, this.compute())
      this.ports.notifier.notice("info", `RunPod: configuration of ${st.model.id} changed; endpoint ${record.endpointID} was deleted and will be re-provisioned on next use.`)
    } else if (idleTimeoutFor(next, this.settings) !== idleTimeoutFor(st.model, this.settings)) {
      await this.compute().setIdleTimeout(record.endpointID, idleTimeoutFor(next, this.settings))
    }
  }

  async remove(modelID: string): Promise<"removed" | "reset"> {
    const st = this.state(modelID)
    this.ensureNotBusy(st)
    if (this.runtimeIDs.has(modelID)) {
      if (st.record) await this.teardown(st, this.compute())
      await this.ports.store.remove(modelKey(modelID))
      if (st.idleTimer !== null) this.ports.clock.clearTimer(st.idleTimer)
      this.states.delete(modelID)
      this.runtimeIDs.delete(modelID)
      await this.publish()
      return "removed"
    }
    const base = findModel(this.settings, modelID)!
    await this.syncEndpoint(st, base)
    await this.ports.store.remove(overridesKey(modelID))
    st.model = base
    st.rate = null
    if (st.phase === "ready") this.armIdle(st)
    await this.publish()
    return "reset"
  }
```

#### E. `status()` never writes `st.rate` (I3)

The loop currently starts with `st.rate = await this.rateFor(st.model)`. Replace that line with:

```ts
      // Display rate: fresh from the catalog, else the rate captured when the endpoint was priced. Never written back —
      // st.rate is what the meter charges, and a failed lookup (ratePerHour 0) must not replace it.
      const lookup = await this.rateFor(st.model)
      const rate = lookup.ratePerHour > 0 || st.rate === null ? lookup : st.rate
```

Then set `ratePerHour: hourlyRate(rate, st.model.gpuCount)` and `gpuLabel: rate.label`.

In `start()`'s reconcile, the two `st.rate = await this.rateFor(st.model)` lines (restore and adopt) become `st.rate = await this.knownRate(st.model)`.

#### F. `start()` always publishes (R-B)

Move the body of `if (compute) { … }` into `private async reconcile(compute: ComputeProviderPort): Promise<void>` and call it guarded:

```ts
    const compute = this.ports.compute
    if (compute) {
      try {
        await this.reconcile(compute)
      } catch (error) {
        this.ports.logger.warn("startup reconcile failed", { error: String(error) })
        this.ports.notifier.notice("warning", `RunPod: could not reconcile endpoints at startup (${(error as Error).message}); stored endpoints are re-checked on the next start.`)
      }
    }
    await this.publish()
```

#### G. `add()` persists first (I4); the recipe invariant is documented (I5); the fakes gain gates

- In `add()`, move `await this.ports.store.set(modelKey(id), config)` so it runs before `this.newState(config)` and `this.runtimeIDs.add(id)`.
- In `src/core/ports/worker-recipe.ts`, add this doc comment on `recipe(...)`:
  `` /** `weightsGb` may only size the disk: image and env must not depend on it, because the startup reconcile recomputes the spec hash with `weightsGb = null`. */ ``
- In `test/fakes/compute.ts` (`FakeCompute`):
  - add `failList: Error | null = null`. In `list()`, after `this.calls.push("list")`, add `if (this.failList) throw this.failList`.
  - add `deleteGate: Promise<void> | null = null`. In `delete()`, after `this.calls.push(...)`, add `if (this.deleteGate) await this.deleteGate`.
- In `test/fakes/confirmation.ts` (`ScriptedConfirmation`): add `gate: Promise<void> | null = null`. In `ask()`, after `this.asked.push(proposal)`, add `if (this.gate) await this.gate`.

#### H. Tests

##### New file `test/service-inflight-ops.test.ts`

```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { flush } from "./fakes/clock.ts"
import { harness } from "./fakes/fixtures.ts"

async function warm(h: ReturnType<typeof harness>) {
  const p = h.service.ensureReady("m")
  await flush()
  h.compute.finishWarmup()
  await p
}

test("down during a cold start cancels the pending request, deletes the endpoint and emits one cold event", async () => {
  const h = harness()
  const pending = h.service.ensureReady("m")
  await flush()
  assert.equal(h.service.phase("m"), "warming")
  const cancelled = assert.rejects(pending, /cold start of m was cancelled: endpoint ep1 is being deleted/)
  assert.deepEqual(await h.service.down("m"), ["m"])
  await cancelled
  assert.equal(h.service.phase("m"), "cold")
  const phases = h.notifier.phases
  assert.deepEqual(phases.slice(phases.indexOf("warming")), ["warming", "deleting", "cold"])
  assert.throws(() => h.compute.finishWarmup(), /no pending warm-up/) // the warm-up request was aborted
  assert.equal(h.compute.calls.filter((c) => c.startsWith("diagnostics:")).length, 0)
  assert.ok(h.compute.calls.includes("delete:ep1"))
  assert.equal(await h.store.get("endpoints/m"), undefined)
  // the model is usable again: the next request provisions a fresh endpoint
  const again = h.service.ensureReady("m")
  await flush()
  assert.equal(h.confirmation.asked.length, 2)
  h.compute.finishWarmup()
  assert.equal(await again, "https://compute.test/ep2/v1")
})

test("down, set and remove refuse while the provision dialog is open; down() for all skips the model", async () => {
  const h = harness()
  let answer!: () => void
  h.confirmation.gate = new Promise<void>((resolve) => {
    answer = resolve
  })
  const pending = h.service.ensureReady("m")
  await flush()
  assert.equal(h.service.phase("m"), "confirming")
  await assert.rejects(h.service.down("m"), /RunPod: m is busy \(confirming\)/)
  assert.deepEqual(await h.service.down(), [])
  await assert.rejects(h.service.set("m", { idleTimeout: 60 }), /m is busy \(confirming\)/)
  await assert.rejects(h.service.remove("m"), /m is busy \(confirming\)/)
  answer()
  await flush()
  assert.equal(h.service.phase("m"), "warming")
  h.compute.finishWarmup()
  assert.equal(await pending, "https://compute.test/ep1/v1")
  assert.equal((await h.service.set("m", { idleTimeout: 60 })).idleTimeout, 60)
})

test("while an endpoint is being deleted, requests and edits are refused", async () => {
  const h = harness()
  await warm(h)
  let release!: () => void
  h.compute.deleteGate = new Promise<void>((resolve) => {
    release = resolve
  })
  const deleting = h.service.down("m")
  await flush()
  assert.equal(h.service.phase("m"), "deleting")
  await assert.rejects(h.service.ensureReady("m"), /RunPod: m is busy \(deleting\)/)
  await assert.rejects(h.service.set("m", { idleTimeout: 60 }), /m is busy \(deleting\)/)
  await assert.rejects(h.service.down("m"), /m is busy \(deleting\)/)
  release()
  assert.deepEqual(await deleting, ["m"])
  assert.equal(h.service.phase("m"), "cold")
  assert.equal(h.compute.calls.filter((c) => c.startsWith("delete:")).length, 1)
})
```

##### Append to `test/service-lifecycle.test.ts`

Change its line 3 import to `import { BILLING_TTL_MS, EndpointService, IDLE_GRACE_MS } from "../src/core/application/endpoint-service.ts"`, then append:

```ts
test("start still publishes the catalog and warns when RunPod cannot be listed", async () => {
  const h = harness()
  await h.store.set("models/extra", sampleModel({ id: "extra", name: "Extra" }))
  h.compute.failList = new Error("fetch failed")
  await h.service.start()
  assert.deepEqual(h.publisher.latest?.map((m) => m.config.id), ["m", "extra"])
  const notice = h.notifier.notices.at(-1)
  assert.equal(notice?.level, "warning")
  assert.match(notice?.message ?? "", /could not reconcile endpoints at startup \(fetch failed\)/)
  assert.equal(h.service.phase("m"), "cold")
})

test("down() for all keeps going after a failed delete and reports every failure", async () => {
  const two = harness({ models: [sampleModel(), sampleModel({ id: "n", hf: "Qwen/Qwen3-8B", gpu: "AMPERE_16" })] })
  await warm(two, "m")
  await warm(two, "n")
  two.compute.failDelete = new Error("forbidden")
  await assert.rejects(two.service.down(), /could not delete m \(forbidden\), n \(forbidden\)/)
  assert.ok(two.compute.calls.includes("delete:ep1"))
  assert.ok(two.compute.calls.includes("delete:ep2"))
  assert.equal(two.service.phase("n"), "error")
})

test("a restarted service recognises the endpoint it created (create-time hash equals the reconcile hash)", async () => {
  const h = harness()
  await warm(h)
  const restarted = new EndpointService(h.settings, {
    compute: h.compute,
    catalog: h.catalog,
    weights: h.weights,
    recipe: h.recipe,
    store: h.store,
    clock: h.clock,
    confirmation: h.confirmation,
    notifier: h.notifier,
    publisher: h.publisher,
    logger: h.logger,
  })
  await restarted.start()
  assert.equal(restarted.phase("m"), "idle")
  assert.equal(h.compute.calls.filter((c) => c.startsWith("delete:")).length, 0)
  const p = restarted.ensureReady("m") // restored → warms without a dialog or a second endpoint
  await flush()
  assert.equal(h.confirmation.asked.length, 1)
  assert.equal(h.compute.created.length, 1)
  h.compute.finishWarmup()
  assert.equal(await p, "https://compute.test/ep1/v1")
})

test("a failed price lookup in status() does not replace the rate the meter charges", async () => {
  const h = harness()
  await warm(h) // ready at t=0, metering $1.22/h
  h.catalog.fail = true
  assert.equal((await h.service.status()).models[0]!.ratePerHour, 1.22) // falls back to the rate captured at provisioning
  await h.clock.advance(120_000 + IDLE_GRACE_MS) // idle; the meter stopped at t=120s
  const before = (await h.service.status()).models[0]!.spendUsd
  await warm(h) // re-warm while the catalog is still down
  await h.clock.advance(60_000)
  const after = (await h.service.status()).models[0]!.spendUsd
  assert.ok(after > before, `the re-warmed worker is metered (${before} → ${after})`)
})
```

##### Append to `test/service-runtime-config.test.ts`

```ts
test("resetting a static model restores the base idle timeout on its live endpoint and re-arms the idle timer", async () => {
  const h = harness()
  await warm(h)
  await h.service.set("m", { idleTimeout: 30 })
  assert.ok(h.compute.calls.includes("setIdleTimeout:ep1:30"))
  assert.equal(await h.service.remove("m"), "reset")
  assert.ok(h.compute.calls.includes("setIdleTimeout:ep1:120"))
  assert.equal(h.service.models()[0]!.idleTimeout, null)
  await h.clock.advance(30_000 + IDLE_GRACE_MS) // the 30 s window no longer applies
  assert.equal(h.service.phase("m"), "ready")
  await h.clock.advance(90_000) // t = 135 s = base 120 s window + grace
  assert.equal(h.service.phase("m"), "idle")
})

test("add persists before registering the model, so a failed write leaves nothing behind", async () => {
  const h = harness()
  h.store.failWrites = (key) => key.startsWith("models/")
  await assert.rejects(h.service.add({ hf: "Qwen/Qwen3-8B" }), /write failed: models\/qwen3-8b/)
  assert.deepEqual(h.service.models().map((m) => m.id), ["m"])
  h.store.failWrites = null
  assert.equal((await h.service.add({ hf: "Qwen/Qwen3-8B" })).id, "qwen3-8b")
})
```

#### I. Expected RED (before any production change; fakes from G already added)

| Test | Expected RED |
|---|---|
| cancel during cold start | times out: nothing aborts the warm-up, so the pending request never settles |
| busy during dialog | `down("m")` resolves `[]` instead of rejecting |
| busy while deleting | times out: `ensureReady` starts a warm-up against the deleting endpoint instead of rejecting |
| start publishes when list fails | `start()` rejects with "fetch failed" |
| down() all best effort | rejects with plain "forbidden"; `delete:ep2` never attempted |
| restarted service recognises its endpoint | passes already (pins the invariant) |
| failed lookup in status() | display shows 0 instead of 1.22 |
| reset restores idle timeout | no `setIdleTimeout:ep1:120` call |
| add persists first | `models()` still lists `qwen3-8b` after the failed write |


Commit:
```bash
git add src/core/application/endpoint-service.ts src/core/ports/worker-recipe.ts test/fakes/compute.ts test/fakes/confirmation.ts test/service-inflight-ops.test.ts test/service-lifecycle.test.ts test/service-runtime-config.test.ts
git commit -m "fix(core): cancel cold starts on down, refuse edits while busy, best-effort teardown, sticky metering rate"
```

---

### Task 6: RunPod REST v2 HTTP client (driven adapter, transport layer)

**Files:**
- Create: `src/adapters/driven/runpod/types.ts`, `src/adapters/driven/runpod/http.ts` (delete `src/adapters/driven/.gitkeep`)
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

type Handler = Response | ((url: string, init: RequestInit) => Response | Promise<Response>)

function fakeFetch(handlers: Handler[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    const handler = handlers.shift()
    if (!handler) throw new Error(`unexpected fetch ${url}`)
    return typeof handler === "function" ? handler(url, init ?? {}) : handler
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

test("error bodies that echo the API key are redacted", async () => {
  const { c } = client([json(401, { title: "Unauthorized", detail: "invalid key rp_key" })])
  await assert.rejects(c.listEndpoints(), (error: unknown) => {
    assert.ok(error instanceof RunpodError)
    assert.equal(error.detail, "invalid key [redacted]")
    assert.ok(!error.message.includes("rp_key"))
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

const createBody = { name: "oc-runpod-m", type: "QUEUE" as const, scaling: { type: "QUEUE_DELAY" as const, queueDelay: 1 }, gpu: { pools: ["AMPERE_48"], count: 1 }, image: "img", env: {}, disk: 20, workers: { min: 0, max: 1, idleTimeout: 120 }, timeout: 600000, flashboot: "FLASHBOOT" as const }

test("createEndpoint is not re-sent after an ambiguous failure; only 429 is retried", async () => {
  const network = client([() => { throw new Error("socket hang up") }])
  await assert.rejects(network.c.createEndpoint(createBody), /socket hang up/)
  assert.equal(network.calls.length, 1)
  const gateway = client([json(502, { title: "Bad Gateway" })])
  await assert.rejects(gateway.c.createEndpoint(createBody), (e: unknown) => e instanceof RunpodError && e.status === 502)
  assert.equal(gateway.calls.length, 1)
  const limited = client([json(429, { title: "Too Many" }), json(201, { id: "ep1", name: "oc-runpod-m" })])
  assert.equal((await limited.c.createEndpoint(createBody)).id, "ep1")
  assert.equal(limited.calls.length, 2)
})

test("idempotent requests retry network errors, then succeed", async () => {
  const sleeps: number[] = []
  const { c, calls } = client([() => { throw new Error("ECONNRESET") }, json(200, { id: "ep1", name: "n" })], sleeps)
  assert.equal((await c.getEndpoint("ep1")).id, "ep1")
  assert.equal(calls.length, 2)
  assert.deepEqual(sleeps, [1000])
})

test("listEndpoints stops on a repeated cursor instead of looping forever", async () => {
  const { c, calls } = client([
    json(200, { data: [{ id: "a", name: "oc-runpod-a" }], pagination: { nextCursor: "c1", hasNextPage: true } }),
    json(200, { data: [{ id: "b", name: "oc-runpod-b" }], pagination: { nextCursor: "c1", hasNextPage: true } }),
  ])
  await assert.rejects(c.listEndpoints(), /repeated cursor "c1"/)
  assert.equal(calls.length, 2)
})

test("listEndpoints gives up after 100 pages", async () => {
  const { c, calls } = client(Array.from({ length: 100 }, (_, i) => json(200, { data: [], pagination: { nextCursor: `c${i}`, hasNextPage: true } })))
  await assert.rejects(c.listEndpoints(), /exceeded 100 pages/)
  assert.equal(calls.length, 100)
})

test("API keys echoed in a problem title or message are redacted too", async () => {
  const { c } = client([json(401, { title: "bad rp_key", message: "key rp_key rejected" })])
  await assert.rejects(c.listEndpoints(), (error: unknown) => {
    assert.ok(error instanceof RunpodError)
    assert.equal(error.title, "bad [redacted]")
    assert.equal(error.detail, "key [redacted] rejected")
    return true
  })
})

test("a 2xx body that is not JSON becomes a RunpodError without echoing the body", async () => {
  const { c } = client([new Response("invalid key rp_key", { status: 200 })])
  await assert.rejects(c.getEndpoint("ep1"), (error: unknown) => {
    assert.ok(error instanceof RunpodError)
    assert.equal(error.title, "invalid JSON response")
    assert.ok(!error.message.includes("rp_key"))
    return true
  })
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
  /** false for requests that must not be re-sent after an ambiguous failure (network error or 5xx): only 429 is retried. */
  idempotent?: boolean
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
    const seen = new Set<string>()
    let cursor: string | undefined
    for (let pages = 1; ; pages++) {
      const url = `${this.apiBase}/serverless${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`
      const page = await this.request<unknown>("GET", url)
      out.push(...extractItems<EndpointInfo>(page))
      const next = nextCursor(page)
      if (next === undefined) return out
      if (seen.has(next)) throw new Error(`RunPod: endpoint listing repeated cursor ${JSON.stringify(next)}`)
      if (pages >= MAX_PAGES) throw new Error(`RunPod: endpoint listing exceeded ${MAX_PAGES} pages`)
      seen.add(next)
      cursor = next
    }
  }

  createEndpoint(body: CreateEndpointRequest): Promise<EndpointInfo> {
    // A retried create after a lost response would leave a duplicate endpoint.
    return this.request<EndpointInfo>("POST", `${this.apiBase}/serverless`, body, { idempotent: false })
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
    const w: Partial<HealthInfo["workers"]> = raw.workers ?? {}
    const j: Partial<HealthInfo["jobs"]> = raw.jobs ?? {}
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
        // A network error is ambiguous — the server may have acted — so a non-idempotent request is never re-sent.
        if (init.signal?.aborted || init.idempotent === false || attempt >= this.maxRetries) throw error
        await this.sleep(1000 * 2 ** attempt)
        continue
      }
      if (response.status === 429 || (response.status >= 500 && init.idempotent !== false)) {
        if (attempt >= this.maxRetries) throw await this.toError(response, context)
        await response.body?.cancel().catch(() => {})
        await this.sleep(1000 * 2 ** attempt)
        continue
      }
      if (!response.ok) throw await this.toError(response, context)
      if (response.status === 204) return undefined as T
      const text = await response.text()
      if (init.text) return text as T
      if (!text) return undefined as T
      try {
        return JSON.parse(text) as T
      } catch {
        // Never echo the body: it is server text and could carry anything, the API key included.
        throw new RunpodError(response.status, "invalid JSON response", null, context)
      }
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
    return new RunpodError(response.status, this.redact(title), detail === null ? null : this.redact(detail), context)
  }

  /** Error bodies come from the server; never let them carry the API key into messages, logs or toasts. */
  private redact(text: string): string {
    return this.apiKey.length > 0 ? text.split(this.apiKey).join("[redacted]") : text
  }
}

export type RunpodHttpLike = Pick<
  RunpodHttp,
  "openaiBaseURL" | "listEndpoints" | "createEndpoint" | "getEndpoint" | "patchEndpoint" | "deleteEndpoint" | "listWorkers" | "workerLogs" | "catalogGpus" | "billedUsd" | "health" | "chatCompletion"
>

const ITEM_KEYS = ["data", "items", "endpoints", "results", "workers", "gpus", "records"] as const

/** Upper bound on pages followed by listEndpoints: a server that never stops paginating must not hang startup. */
const MAX_PAGES = 100

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
- Produces: `POOLS`, `MARKER_ENV = "OPENCODE_RUNPOD"`, `HASH_ENV = "OPENCODE_RUNPOD_HASH"`, `toCreateBody(spec)`, `class RunpodComputeProvider implements ComputeProviderPort { constructor(http: RunpodHttpLike) }` (incl. `setIdleTimeout` → `PATCH workers.idleTimeout`), `class RunpodPriceCatalog implements PriceCatalogPort { constructor(http: { catalogGpus() } | null, clock: ClockPort, ttlMs = 600000) }`.

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
  lastChat: { body: unknown; signal: AbortSignal } | null = null
  async chatCompletion(id: string, body: unknown, signal: AbortSignal) { this.calls.push(`chat:${id}`); this.lastChat = { body, signal }; if (this.chatError) throw this.chatError; return {} }
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

test("scaleToZero and setIdleTimeout patch workers; delete tolerates 404 only", async () => {
  const http = new FakeHttp()
  const provider = new RunpodComputeProvider(http)
  await provider.scaleToZero("ep1")
  assert.equal(http.calls.at(-1), 'patch:ep1:{"workers":{"min":0,"max":0}}')
  await provider.setIdleTimeout("ep1", 30)
  assert.equal(http.calls.at(-1), 'patch:ep1:{"workers":{"idleTimeout":30}}')
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

test("warmup posts a one-token ping for the served model name, forwards the abort signal, and treats 408 as transient", async () => {
  const http = new FakeHttp()
  const provider = new RunpodComputeProvider(http)
  const controller = new AbortController()
  await provider.warmup("ep1", "m", controller.signal)
  assert.deepEqual(http.lastChat?.body, { model: "m", messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false })
  assert.equal(http.lastChat?.signal, controller.signal)
  http.chatError = new RunpodError(408, "Request Timeout", null, "POST")
  await assert.rejects(provider.warmup("ep1", "m", controller.signal), (e: unknown) => e instanceof ComputeError && e.kind === "transient" && e.status === 408)
})

test("create sends exactly toCreateBody(spec); an empty minCudaVersion is omitted", async () => {
  const http = new FakeHttp()
  await new RunpodComputeProvider(http).create(spec)
  assert.deepEqual(http.calls, [`create:${JSON.stringify(toCreateBody(spec))}`])
  const body = toCreateBody({ ...spec, gpu: { ...spec.gpu, minCudaVersion: "" } })
  assert.equal("minCudaVersion" in body.gpu, false)
})

test("diagnostics is best effort: log failures and empty logs yield null; CRLF logs are normalised", async () => {
  const http = new FakeHttp()
  const provider = new RunpodComputeProvider(http)
  http.workers = [{ id: "w2", status: "UNHEALTHY" }]
  http.logs = "  \n "
  assert.equal(await provider.diagnostics("ep1"), null)
  http.logs = "a\r\nb\r\n"
  assert.equal(await provider.diagnostics("ep1"), "a\nb")
  http.workerLogs = async () => {
    throw new Error("gone")
  }
  assert.equal(await provider.diagnostics("ep1"), null)
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

test("concurrent lookups share one catalog request", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  const h = {
    catalogGpus: async () => {
      calls++
      await gate
      return [{ id: "x", pool: "AMPERE_16", price: { serverless: 0.6 } }]
    },
  }
  const catalog = new RunpodPriceCatalog(h, new FakeClock())
  const a = catalog.rate("AMPERE_16")
  const b = catalog.rate("AMPERE_48")
  release()
  assert.equal((await a).ratePerHour, 0.6)
  assert.equal((await b).source, "fallback") // AMPERE_48 is not in this live catalog
  assert.equal(calls, 1)
})

test("a failed lookup is retried after a minute, not after the full TTL", async () => {
  const clock = new FakeClock()
  let fail = true
  let calls = 0
  const h = {
    catalogGpus: async () => {
      calls++
      if (fail) throw new Error("blip")
      return [{ id: "x", pool: "AMPERE_16", price: { serverless: 0.6 } }]
    },
  }
  const catalog = new RunpodPriceCatalog(h, clock)
  assert.equal((await catalog.rate("AMPERE_16")).source, "fallback")
  fail = false
  await clock.advance(30_000)
  assert.equal((await catalog.rate("AMPERE_16")).source, "fallback") // the failure is remembered briefly, not hammered
  assert.equal(calls, 1)
  await clock.advance(31_000)
  assert.deepEqual(await catalog.rate("AMPERE_16"), { ratePerHour: 0.6, source: "catalog", vramGb: POOLS.AMPERE_16.vramGb, label: POOLS.AMPERE_16.label })
  assert.equal(calls, 2)
})

test("a zero live price is ignored in favour of the static table; the pool table fixes VRAM", async () => {
  const catalog = new RunpodPriceCatalog(
    http([
      { id: "a", pool: "AMPERE_16", price: { serverless: 0 } },
      { id: "b", pool: "AMPERE_48", memory: 49152, price: { serverless: 1.3 } },
    ]),
    new FakeClock(),
  )
  assert.equal((await catalog.rate("AMPERE_16")).source, "fallback")
  assert.equal((await catalog.rate("AMPERE_48")).vramGb, 48)
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
    gpu: { pools: [spec.gpu.pool], count: spec.gpu.count },
    image: spec.recipe.image,
    env,
    disk: spec.recipe.diskGb,
    workers: { min: spec.workers.min, max: spec.workers.max, idleTimeout: spec.workers.idleTimeoutSec },
    timeout: spec.executionTimeoutSec * 1000,
    flashboot: spec.flashboot ? "FLASHBOOT" : "OFF",
  }
  if (spec.gpu.minCudaVersion) body.gpu.minCudaVersion = spec.gpu.minCudaVersion
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

  async setIdleTimeout(id: string, seconds: number): Promise<void> {
    await this.http.patchEndpoint(id, { workers: { idleTimeout: seconds } })
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
    try {
      const workers = await this.http.listWorkers(id)
      const unhealthy = workers.find((w) => w.status.toUpperCase() === "UNHEALTHY")
      if (!unhealthy) return null
      const text = (await this.http.workerLogs(id, unhealthy.id)).replace(/\r\n?/g, "\n").trim()
      return text ? text.split("\n").slice(-LOG_TAIL_LINES).join("\n") : null
    } catch {
      return null // best effort: the caller is already reporting a failed cold start
    }
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
/** A failed lookup is retried after this long: a broken catalog is not hammered, but a blip does not pin fallback prices for a full TTL. */
export const CATALOG_FAILURE_TTL_MS = 60_000

export class RunpodPriceCatalog implements PriceCatalogPort {
  private readonly http: { catalogGpus(): Promise<GpuCatalogEntry[]> } | null
  private readonly clock: ClockPort
  private readonly ttlMs: number
  private cache: { at: number; entries: GpuCatalogEntry[] | null } | null = null
  private pending: Promise<GpuCatalogEntry[] | null> | null = null

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
    const live = entries?.find((e) => e.pool === pool && (e.price?.serverless ?? 0) > 0)
    // The pool id fixes the VRAM; the live catalog's `memory` is only a fallback for pools missing from the table.
    if (live) return { ratePerHour: live.price!.serverless!, source: "catalog", vramGb: info?.vramGb ?? live.memory ?? null, label: info?.label ?? pool }
    return { ratePerHour: info?.fallbackUsdPerHour ?? 0, source: "fallback", vramGb: info?.vramGb ?? null, label: info?.label ?? pool }
  }

  private entries(): Promise<GpuCatalogEntry[] | null> {
    const http = this.http
    if (!http) return Promise.resolve(null)
    const now = this.clock.now()
    if (this.cache) {
      const ttl = this.cache.entries === null ? Math.min(CATALOG_FAILURE_TTL_MS, this.ttlMs) : this.ttlMs
      if (now - this.cache.at <= ttl) return Promise.resolve(this.cache.entries)
    }
    // Concurrent callers share one lookup, so a slow failure can never overwrite a fresh success.
    if (!this.pending) {
      this.pending = http
        .catalogGpus()
        .catch(() => null)
        .then((entries) => {
          this.cache = { at: now, entries }
          return entries
        })
        .finally(() => {
          this.pending = null
        })
    }
    return this.pending
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

test("counts the shard set once when a repo also ships consolidated weights (Mistral layout)", async () => {
  const result = await fetchWeightsGb("mistralai/Mistral-7B-Instruct-v0.3", {
    fetch: fetchReturning(200, {
      siblings: [
        { rfilename: "consolidated.safetensors", size: 14.5 * GB },
        { rfilename: "model-00001-of-00003.safetensors", size: 4.95 * GB },
        { rfilename: "model-00002-of-00003.safetensors", size: 5 * GB },
        { rfilename: "model-00003-of-00003.safetensors", size: 4.55 * GB },
      ],
    }),
  })
  assert.deepEqual(result, { weightsGb: 14.5, files: 3, source: "safetensors" })
})

test("ignores weights in subfolders and prefers model.safetensors among single files", async () => {
  const result = await fetchWeightsGb("org/repo", {
    fetch: fetchReturning(200, {
      siblings: [
        { rfilename: "model.safetensors", size: 8 * GB },
        { rfilename: "consolidated.safetensors", size: 8 * GB },
        { rfilename: "original/model.safetensors", size: 16 * GB },
      ],
    }),
  })
  assert.deepEqual(result, { weightsGb: 8, files: 1, source: "safetensors" })
})

test("a gguf repo with several quantizations is ambiguous; a single sharded quant is summed", async () => {
  const multi = await fetchWeightsGb("org/model-GGUF", {
    fetch: fetchReturning(200, { siblings: [{ rfilename: "m-Q4_K_M.gguf", size: 18 * GB }, { rfilename: "m-Q8_0.gguf", size: 32 * GB }] }),
  })
  assert.equal(multi, null)
  const sharded = await fetchWeightsGb("org/model-GGUF", {
    fetch: fetchReturning(200, { siblings: [{ rfilename: "m-Q8_0-00001-of-00002.gguf", size: 20 * GB }, { rfilename: "m-Q8_0-00002-of-00002.gguf", size: 12 * GB }] }),
  })
  assert.deepEqual(sharded, { weightsGb: 32, files: 2, source: "gguf" })
})

test("malformed Hub payloads and empty sizes yield null", async () => {
  assert.equal(await fetchWeightsGb("org/a", { fetch: fetchReturning(200, null) }), null)
  assert.equal(await fetchWeightsGb("org/b", { fetch: fetchReturning(200, { siblings: "nope" }) }), null)
  assert.equal(await fetchWeightsGb("org/c", { fetch: fetchReturning(200, { siblings: [null, { rfilename: "model.safetensors" }] }) }), null)
  assert.equal(await fetchWeightsGb("org/d", { fetch: fetchReturning(200, { siblings: [{ rfilename: "model.safetensors", size: 0 }] }) }), null)
})

test("a hung Hub request is abandoned after the timeout", async () => {
  const hanging = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init!.signal!.reason), { once: true })
    })) as unknown as typeof fetch
  const started = Date.now()
  assert.equal(await fetchWeightsGb("org/slow", { fetch: hanging, timeoutMs: 20 }), null)
  assert.ok(Date.now() - started < 2_000)
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

/** Metadata lookups are small; a hung Hub request must not stall the provisioning dialog. */
export const HF_TIMEOUT_MS = 10_000

interface Sibling {
  rfilename: string
  size: number
}

const isSibling = (value: unknown): value is Sibling =>
  typeof value === "object" && value !== null && typeof (value as Sibling).rfilename === "string" && typeof (value as Sibling).size === "number"

const SHARD = /^(.*)-\d{5}-of-\d{5}\.(?:safetensors|gguf)$/

/** Root-level shard sets keyed by their prefix (`model-00001-of-00003.safetensors` → `model`). */
function shardGroups(files: Sibling[]): Map<string, Sibling[]> {
  const groups = new Map<string, Sibling[]>()
  for (const file of files) {
    const match = SHARD.exec(file.rfilename)
    if (match) groups.set(match[1]!, [...(groups.get(match[1]!) ?? []), file])
  }
  return groups
}

/** The safetensors a loader reads: the `model-*` shard set (or the only shard set), else `model.safetensors`, else the only file; null when ambiguous. */
function pickSafetensors(root: Sibling[]): Sibling[] | null {
  const groups = shardGroups(root)
  const sharded = groups.get("model") ?? (groups.size === 1 ? [...groups.values()][0]! : undefined)
  if (sharded) return sharded
  if (groups.size > 1) return null
  const single = root.find((f) => f.rfilename === "model.safetensors")
  if (single) return [single]
  return root.length === 1 ? root : null
}

/** GGUF repos usually hold several quantizations and only one is ever loaded: size only a single file or a single shard set. */
function pickGguf(root: Sibling[]): Sibling[] | null {
  if (root.length === 1) return root
  const groups = shardGroups(root)
  const only = groups.size === 1 ? [...groups.values()][0]! : undefined
  return only && only.length === root.length ? only : null
}

/** Size of the weight files a loader would read, via the public Hub API (`?blobs=true` includes sizes). Null when unknown or ambiguous. */
export async function fetchWeightsGb(
  hf: string,
  opts: { token?: string | null; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<HfSizeResult | null> {
  const fetchImpl = opts.fetch ?? fetch
  const headers: Record<string, string> = { accept: "application/json" }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  const path = hf.split("/").map(encodeURIComponent).join("/")
  let data: unknown
  try {
    const response = await fetchImpl(`https://huggingface.co/api/models/${path}?blobs=true`, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? HF_TIMEOUT_MS) })
    if (!response.ok) return null
    data = await response.json()
  } catch {
    return null
  }
  const listed = (data as { siblings?: unknown } | null)?.siblings
  const siblings = Array.isArray(listed) ? listed.filter(isSibling) : []
  // Subfolders hold duplicates (original/, onnx/, alternative quantizations): only root-level files are loaded.
  const root = (ext: string) => siblings.filter((s) => !s.rfilename.includes("/") && s.rfilename.endsWith(ext))
  const safetensors = root(".safetensors")
  const source: HfSizeResult["source"] = safetensors.length > 0 ? "safetensors" : "gguf"
  const files = safetensors.length > 0 ? pickSafetensors(safetensors) : root(".gguf").length > 0 ? pickGguf(root(".gguf")) : null
  if (!files || files.length === 0) return null
  const bytes = files.reduce((sum, s) => sum + s.size, 0)
  if (bytes <= 0) return null
  return { weightsGb: Math.max(0.1, Math.round(bytes / 1e8) / 10), files: files.length, source }
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
- Consumes: domain types `Quote`, `StateEvent`, `ModelStatus` (incl. `workers: WorkerCounts | null`), `StatusReport`, `Phase`, `NoticeLevel`, `GpuOption`, `ProvisionProposal`, `ProvisionOverrides`.
- Produces (`contract.ts`): `PhaseSchema`, `QuoteSchema: z.ZodType<Quote>`, `GpuOptionSchema: z.ZodType<GpuOption>`, `ProvisionProposalSchema: z.ZodType<ProvisionProposal>`, `ProvisionOverridesSchema: z.ZodType<ProvisionOverrides>`, `StateEventSchema: z.ZodType<StateEvent>`, `ModelStatusSchema: z.ZodType<ModelStatus>`, `StatusReportSchema: z.ZodType<StatusReport>`, `NoticeSchema`, `RunpodRpc` (`id: "runpod"`, methods `status/up/down/confirm`, events `confirm.requested/state/notice`).
- Produces (`format.ts`): `formatUsd`, `formatDuration`, `formatQuote`, `formatGpuOption(option)`, `formatIdleChoice(seconds, ratePerHour)`, `phaseLabel`, `footerLabel`, `formatStatus`, `formatModel(config)`.

- [ ] **Step 1: Write the failing tests**

`test/rpc-contract.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { ProvisionProposalSchema, QuoteSchema, RunpodRpc, StateEventSchema, StatusReportSchema } from "../rpc.ts"

const quote = { modelID: "m", hf: "a/b", gpu: "AMPERE_48", gpuLabel: "A6000/A40 48GB", gpuCount: 1, ratePerHour: 1.22, rateSource: "catalog", weightsGb: 31.6, estColdStartSec: 156, idleTimeout: 120, idleWindowUsd: 0.04, warnings: [], blocked: null }

test("contract exposes the four methods and three events", () => {
  assert.equal(RunpodRpc.id, "runpod")
  assert.deepEqual(Object.keys(RunpodRpc.methods).sort(), ["confirm", "down", "status", "up"])
  assert.deepEqual(Object.keys(RunpodRpc.events).sort(), ["confirm.requested", "notice", "state"])
})

test("schemas accept well-formed payloads and reject bad phases", () => {
  assert.equal(QuoteSchema.safeParse(quote).success, true)
  const state = { modelID: "m", phase: "warming", detail: "starting", elapsedSec: 3, spendUsd: 0.001, ratePerHour: 1.22, gpu: "AMPERE_48", gpuLabel: "A6000/A40 48GB" }
  assert.equal(StateEventSchema.safeParse(state).success, true)
  assert.equal(StateEventSchema.safeParse({ ...state, phase: "hot" }).success, false)
  assert.equal(StatusReportSchema.safeParse({ models: [], orphans: [] }).success, true)
})

test("proposal and confirm payloads round-trip", () => {
  const proposal = { quote, gpuOptions: [{ pool: "AMPERE_48", label: "A6000/A40 48GB", ratePerHour: 1.22, rateSource: "catalog", vramGb: 48, fits: true, estColdStartSec: 156, current: true }], idleTimeoutChoices: [30, 60] }
  assert.equal(ProvisionProposalSchema.safeParse(proposal).success, true)
  const confirmInput = RunpodRpc.methods.confirm.input
  assert.equal(confirmInput.safeParse({ requestID: "r1", accepted: true, overrides: { gpu: "AMPERE_80", idleTimeout: 60 } }).success, true)
  assert.equal(confirmInput.safeParse({ requestID: "r1", accepted: false }).success, true)
  assert.equal(confirmInput.safeParse({ requestID: "r1" }).success, false)
})
```

`test/format.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { footerLabel, formatDuration, formatGpuOption, formatIdleChoice, formatModel, formatQuote, formatStatus, formatUsd, phaseLabel } from "../src/adapters/driving/rpc/format.ts"
import type { StateEvent, StatusReport } from "../src/core/domain/events.ts"
import type { GpuOption } from "../src/core/domain/provision.ts"
import type { Quote } from "../src/core/domain/quote.ts"
import { sampleModel } from "./fakes/fixtures.ts"

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

test("formatGpuOption and formatIdleChoice", () => {
  const option: GpuOption = { pool: "AMPERE_48", label: "A6000/A40 48GB", ratePerHour: 1.22, rateSource: "catalog", vramGb: 48, fits: true, estColdStartSec: 156, current: true }
  assert.equal(formatGpuOption(option), "A6000/A40 48GB — $1.22/h · fits · cold start ≈ 2m 36s · current")
  assert.equal(formatGpuOption({ ...option, fits: false, current: false, rateSource: "fallback" }), "A6000/A40 48GB — $1.22/h (static price) · too small · cold start ≈ 2m 36s")
  assert.equal(formatGpuOption({ ...option, fits: null, current: false }), "A6000/A40 48GB — $1.22/h · fit unknown · cold start ≈ 2m 36s")
  assert.equal(formatIdleChoice(120, 1.22), "2m 0s ≈ $0.04 per idle window")
  assert.equal(formatIdleChoice(1800, 2.72), "30m 0s ≈ $1.36 per idle window")
})

test("phaseLabel and footerLabel", () => {
  assert.equal(phaseLabel({ phase: "ready", elapsedSec: null }), "warm")
  assert.equal(phaseLabel({ phase: "warming", elapsedSec: 87 }), "warming 87s")
  assert.equal(phaseLabel({ phase: "idle", elapsedSec: null }), "cold")
  assert.equal(phaseLabel({ phase: "confirming", elapsedSec: null }), "confirm?")
  assert.equal(footerLabel(null), "")
  assert.equal(footerLabel(event), "runpod A6000/A40 48GB · warm · $1.22/h · ≈$0.42")
})

test("formatStatus prints one line per model plus orphans; formatModel prints the effective config", () => {
  const status: StatusReport = {
    models: [
      { modelID: "m", phase: "ready", detail: "ready in 142s", spendUsd: 0.42, ratePerHour: 1.22, gpu: "AMPERE_48", gpuLabel: "A6000/A40 48GB", endpointID: "ep1", gpuCount: 1, billedUsd: 0.5, lastRequestAt: 1, workers: { initializing: 1, running: 1, idle: 0, throttled: 0 } },
      { modelID: "n", phase: "cold", detail: null, spendUsd: 0, ratePerHour: 2.72, gpu: "AMPERE_80", gpuLabel: "A100 80GB", endpointID: null, gpuCount: 2, billedUsd: null, lastRequestAt: null, workers: null },
    ],
    orphans: [{ id: "epX", name: "oc-runpod-old" }],
  }
  const lines = formatStatus(status).split("\n")
  assert.equal(lines[0], "m: ready [ep1] · A6000/A40 48GB $1.22/h · session ≈$0.42 · billed $0.50 · workers 1 running / 0 idle / 1 starting · ready in 142s")
  assert.equal(lines[1], "n: cold · A100 80GB ×2 $2.72/h · session ≈$0.00")
  assert.equal(lines[2], "Unmanaged oc-runpod-* endpoints: oc-runpod-old [epX]")
  assert.equal(formatStatus({ models: [], orphans: [] }), "RunPod: no models configured (options.models or /runpod-add)")
  assert.equal(formatModel(sampleModel({ idleTimeout: 60, toolParser: null })), "m: hf=Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8 gpu=AMPERE_48 gpuCount=1 context=65536 output=8192 tools=true family=auto toolParser=null reasoningParser=preset quantization=fp8 weightsGb=auto idleTimeout=60")
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot find `rpc.ts` / `format.ts`.

- [ ] **Step 3: Implement `src/adapters/driving/rpc/contract.ts`**

```ts
import type { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import type { Phase } from "../../../core/domain/endpoint.ts"
import type { ModelStatus, NoticeLevel, StateEvent, StatusReport } from "../../../core/domain/events.ts"
import type { GpuOption, ProvisionOverrides, ProvisionProposal } from "../../../core/domain/provision.ts"
import type { Quote } from "../../../core/domain/quote.ts"

export const PhaseSchema: z.ZodType<Phase> = z.enum(["cold", "confirming", "creating", "warming", "ready", "idle", "deleting", "error"])
const RateSourceSchema = z.enum(["catalog", "fallback"])

export const QuoteSchema: z.ZodType<Quote> = z.object({
  modelID: z.string(),
  hf: z.string(),
  gpu: z.string(),
  gpuLabel: z.string(),
  gpuCount: z.number().int().min(1),
  ratePerHour: z.number(),
  rateSource: RateSourceSchema,
  weightsGb: z.number().nullable(),
  estColdStartSec: z.number(),
  idleTimeout: z.number(),
  idleWindowUsd: z.number(),
  warnings: z.array(z.string()),
  blocked: z.string().nullable(),
})

export const GpuOptionSchema: z.ZodType<GpuOption> = z.object({
  pool: z.string(),
  label: z.string(),
  ratePerHour: z.number(),
  rateSource: RateSourceSchema,
  vramGb: z.number().nullable(),
  fits: z.boolean().nullable(),
  estColdStartSec: z.number(),
  current: z.boolean(),
})

export const ProvisionProposalSchema: z.ZodType<ProvisionProposal> = z.object({
  quote: QuoteSchema,
  gpuOptions: z.array(GpuOptionSchema),
  idleTimeoutChoices: z.array(z.number()),
})

export const ProvisionOverridesSchema: z.ZodType<ProvisionOverrides> = z.object({
  gpu: z.string().optional(),
  idleTimeout: z.number().int().optional(),
})

// `satisfies` (not an annotation): the RPC event-schema union needs the concrete ZodObject type; drift is still caught.
export const StateEventSchema = z.object({
  modelID: z.string(),
  phase: PhaseSchema,
  detail: z.string().nullable(),
  elapsedSec: z.number().nullable(),
  spendUsd: z.number(),
  ratePerHour: z.number(),
  gpu: z.string(),
  gpuLabel: z.string(),
}) satisfies z.ZodType<StateEvent>

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
  workers: z.object({ initializing: z.number(), running: z.number(), idle: z.number(), throttled: z.number() }).nullable(),
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
    confirm: {
      input: z.object({ requestID: z.string(), accepted: z.boolean(), overrides: ProvisionOverridesSchema.optional() }),
      output: z.object({ ok: z.boolean() }),
    },
  },
  events: {
    "confirm.requested": { schema: z.object({ requestID: z.string(), proposal: ProvisionProposalSchema }) },
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
import type { ModelConfig } from "../../../core/domain/model.ts"
import type { GpuOption } from "../../../core/domain/provision.ts"
import { idleWindowUsd, type Quote } from "../../../core/domain/quote.ts"

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

export function formatGpuOption(o: GpuOption): string {
  const fit = o.fits === null ? "fit unknown" : o.fits ? "fits" : "too small"
  const parts = [`${o.label} — ${formatUsd(o.ratePerHour)}/h${o.rateSource === "fallback" ? " (static price)" : ""}`, fit, `cold start ≈ ${formatDuration(o.estColdStartSec)}`]
  if (o.current) parts.push("current")
  return parts.join(" · ")
}

export function formatIdleChoice(seconds: number, ratePerHour: number): string {
  return `${formatDuration(seconds)} ≈ ${formatUsd(idleWindowUsd(ratePerHour, seconds))} per idle window`
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
  if (s.models.length === 0) return "RunPod: no models configured (options.models or /runpod-add)"
  const lines = s.models.map((m) => {
    const parts = [
      `${m.modelID}: ${m.phase}${m.endpointID ? ` [${m.endpointID}]` : ""}`,
      `${m.gpuLabel}${m.gpuCount > 1 ? ` ×${m.gpuCount}` : ""} ${formatUsd(m.ratePerHour)}/h`,
      `session ≈${formatUsd(m.spendUsd)}`,
    ]
    if (m.billedUsd !== null) parts.push(`billed ${formatUsd(m.billedUsd)}`)
    if (m.workers) parts.push(`workers ${m.workers.running} running / ${m.workers.idle} idle${m.workers.initializing > 0 ? ` / ${m.workers.initializing} starting` : ""}`)
    if (m.detail) parts.push(m.detail)
    return parts.join(" · ")
  })
  if (s.orphans.length > 0) lines.push(`Unmanaged oc-runpod-* endpoints: ${s.orphans.map((o) => `${o.name} [${o.id}]`).join(", ")}`)
  return lines.join("\n")
}

/** One-line effective configuration, used by /runpod-add, /runpod-set and /runpod-remove replies. */
export function formatModel(m: ModelConfig): string {
  const tri = (v: string | null | undefined) => (v === undefined ? "preset" : v === null ? "null" : v)
  return [
    `${m.id}: hf=${m.hf}`,
    `gpu=${m.gpu}`,
    `gpuCount=${m.gpuCount}`,
    `context=${m.context}`,
    `output=${m.output}`,
    `tools=${m.tools}`,
    `family=${m.family ?? "auto"}`,
    `toolParser=${tri(m.toolParser)}`,
    `reasoningParser=${tri(m.reasoningParser)}`,
    `quantization=${m.quantization ?? "null"}`,
    `weightsGb=${m.weightsGb ?? "auto"}`,
    `idleTimeout=${m.idleTimeout ?? "default"}`,
  ].join(" ")
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm run check`
Expected: pass. The `z.ZodType<…>` annotations fail typecheck if a DTO drifts from its domain type — intended.

- [ ] **Step 6: Commit**

```bash
git add rpc.ts src/adapters/driving/rpc test/rpc-contract.test.ts test/format.test.ts
git commit -m "feat(rpc): typed RPC contract with provision proposals and text formatting"
```

---

### Task 11: opencode and system driven adapters (state store, notifier, confirmation, catalog publisher, clock, logger)

**Files:**
- Create: `src/adapters/driven/opencode/state-store.ts`, `notifier.ts`, `confirmation.ts`, `catalog-publisher.ts`; `src/adapters/driven/system/clock.ts`, `logger.ts`
- Test: `test/opencode-adapters.test.ts`

**Interfaces:**
- Produces: `interface OpencodeStorageLike { get; set; remove; scan({ prefix, after?, limit? }) → { entries: { key; value }[]; next? } }`, `class OpencodeStateStore implements StateStorePort { constructor(storage: OpencodeStorageLike) }`; `class RpcNotifier implements NotifierPort { constructor(emit: { state(event): void; notice(level, message): void }) }`; `class ConfirmBroker { constructor(timeoutMs, timers?); request(issue: (requestID) => void): Promise<ProvisionDecision>; resolve(requestID, decision): boolean; readonly size }`; `class RpcConfirmation implements ConfirmationPort { constructor(broker, emit: (requestID: string, proposal: ProvisionProposal) => void) }`; `class OpencodeCatalogPublisher implements CatalogPublisherPort { constructor(reload: () => Promise<void>); readonly current: readonly PublishedModel[] }`; `class SystemClock implements ClockPort`; `class ConsoleLogger implements LoggerPort { constructor(prefix, write?) }`.

- [ ] **Step 1: Write the failing test**

`test/opencode-adapters.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { OpencodeCatalogPublisher } from "../src/adapters/driven/opencode/catalog-publisher.ts"
import { ConfirmBroker, RpcConfirmation } from "../src/adapters/driven/opencode/confirmation.ts"
import { RpcNotifier } from "../src/adapters/driven/opencode/notifier.ts"
import { OpencodeStateStore } from "../src/adapters/driven/opencode/state-store.ts"
import { SystemClock } from "../src/adapters/driven/system/clock.ts"
import { ConsoleLogger } from "../src/adapters/driven/system/logger.ts"
import type { ProvisionProposal } from "../src/core/domain/provision.ts"
import type { Quote } from "../src/core/domain/quote.ts"
import type { PublishedModel } from "../src/core/ports/catalog-publisher.ts"
import { sampleModel } from "./fakes/fixtures.ts"

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
const proposal: ProvisionProposal = { quote, gpuOptions: [], idleTimeoutChoices: [30, 60] }

test("ConfirmBroker: accept with overrides, decline, unknown id, timeout", async () => {
  const t = timers()
  const broker = new ConfirmBroker(1000, t)
  let issued = ""
  const accepted = broker.request((id) => { issued = id })
  assert.ok(issued.length > 0)
  assert.equal(broker.size, 1)
  assert.equal(broker.resolve("nope", { accepted: true, overrides: {} }), false)
  assert.equal(broker.resolve(issued, { accepted: true, overrides: { gpu: "AMPERE_80" } }), true)
  assert.deepEqual(await accepted, { accepted: true, overrides: { gpu: "AMPERE_80" } })
  assert.equal(broker.size, 0)
  assert.equal(t.pending.length, 0)

  const declined = broker.request((id) => { issued = id })
  broker.resolve(issued, { accepted: false })
  assert.deepEqual(await declined, { accepted: false })

  const timedOut = broker.request((id) => { issued = id })
  t.fire()
  assert.deepEqual(await timedOut, { accepted: false })
  assert.equal(broker.resolve(issued, { accepted: true, overrides: {} }), false)
})

test("RpcConfirmation emits the proposal with the request id and resolves through the broker", async () => {
  const t = timers()
  const broker = new ConfirmBroker(1000, t)
  const emitted: { requestID: string; proposal: ProvisionProposal }[] = []
  const confirmation = new RpcConfirmation(broker, (requestID, p) => { emitted.push({ requestID, proposal: p }) })
  const pending = confirmation.ask(proposal)
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0]!.proposal, proposal)
  assert.equal(broker.resolve(emitted[0]!.requestID, { accepted: true, overrides: { idleTimeout: 60 } }), true)
  assert.deepEqual(await pending, { accepted: true, overrides: { idleTimeout: 60 } })
})

test("RpcNotifier forwards state and notices", () => {
  const seen: string[] = []
  const notifier = new RpcNotifier({ state: (e) => seen.push(`state:${e.phase}`), notice: (level, message) => seen.push(`${level}:${message}`) })
  notifier.state({ modelID: "m", phase: "ready", detail: null, elapsedSec: 1, spendUsd: 0, ratePerHour: 1, gpu: "g", gpuLabel: "G" })
  notifier.notice("warning", "careful")
  assert.deepEqual(seen, ["state:ready", "warning:careful"])
})

test("OpencodeCatalogPublisher keeps the latest list (copied) and triggers a provider reload", async () => {
  let reloads = 0
  const publisher = new OpencodeCatalogPublisher(async () => { reloads++ })
  assert.deepEqual(publisher.current, [] as PublishedModel[])
  publisher.seed([{ config: sampleModel({ id: "seeded" }), variants: [] }])
  assert.equal(reloads, 0)
  assert.equal(publisher.current[0]!.config.id, "seeded")
  const model = sampleModel()
  await publisher.publish([{ config: model, variants: ["AMPERE_48", "AMPERE_80"] }])
  assert.equal(reloads, 1)
  assert.equal(publisher.current.length, 1)
  assert.deepEqual(publisher.current[0]!.variants, ["AMPERE_48", "AMPERE_80"])
  model.gpu = "CHANGED"
  assert.equal(publisher.current[0]!.config.gpu, "AMPERE_48")
})

test("OpencodeStateStore passes through to ctx.storage and lists keys across scan pages", async () => {
  const backing = new Map<string, unknown>()
  const store = new OpencodeStateStore({
    get: async (key) => backing.get(key),
    set: async (key, value) => { backing.set(key, value) },
    remove: async (key) => { backing.delete(key) },
    scan: async ({ prefix, after, limit }) => {
      const keys = [...backing.keys()].filter((k) => k.startsWith(prefix)).sort()
      const start = after ? keys.indexOf(after) + 1 : 0
      const page = keys.slice(start, start + (limit ?? 100))
      const next = start + page.length < keys.length ? page.at(-1) : undefined
      return { entries: page.map((key) => ({ key, value: backing.get(key) })), next }
    },
  })
  await store.set("models/a", { a: 1 })
  await store.set("models/b", { b: 2 })
  await store.set("models/c", { c: 3 })
  await store.set("other/x", 1)
  assert.deepEqual(await store.get<{ a: number }>("models/a"), { a: 1 })
  assert.deepEqual(await store.keys("models/"), ["models/a", "models/b", "models/c"])
  await store.remove("models/a")
  assert.equal(await store.get("models/a"), undefined)
  assert.deepEqual(await store.keys("models/"), ["models/b", "models/c"])
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

test("SystemClock timers never hold the process open", async () => {
  const clock = new SystemClock()
  const id = clock.setTimer(() => {}, 10_000) as { hasRef?: () => boolean }
  assert.equal(id.hasRef?.(), false)
  clock.clearTimer(id)
  await clock.sleep(5) // an unref'd sleep still resolves
})

test("OpencodeStateStore.keys follows scan pages and stops when a cursor repeats", async () => {
  const pages = [
    { entries: [{ key: "models/b", value: 1 }], next: "c1" },
    { entries: [{ key: "models/a", value: 2 }], next: "c2" },
    { entries: [{ key: "models/c", value: 3 }], next: "c2" }, // a store whose cursor stops advancing
  ]
  const afters: (string | undefined)[] = []
  const store = new OpencodeStateStore({
    get: async () => undefined,
    set: async () => {},
    remove: async () => {},
    scan: async ({ after }) => {
      afters.push(after)
      return pages[afters.length - 1] ?? { entries: [], next: "c2" }
    },
  })
  assert.deepEqual(await store.keys("models/"), ["models/a", "models/b", "models/c"])
  assert.deepEqual(afters, [undefined, "c1", "c2"])
})

test("ConfirmBroker cleans up when issuing the dialog throws and after a timeout; default timers are unref'd", async () => {
  const t = timers()
  const broker = new ConfirmBroker(1000, t)
  await assert.rejects(
    broker.request(() => {
      throw new Error("rpc down")
    }),
    /rpc down/,
  )
  assert.equal(broker.size, 0)
  assert.equal(t.pending.length, 0)
  const timed = broker.request(() => {})
  assert.equal(broker.size, 1)
  t.fire()
  assert.deepEqual(await timed, { accepted: false })
  assert.equal(broker.size, 0)

  const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length
  const before = timeouts()
  const real = new ConfirmBroker(60_000)
  let id = ""
  const pending = real.request((requestID) => {
    id = requestID
  })
  assert.equal(timeouts(), before) // the default timer does not keep the process alive
  real.resolve(id, { accepted: false })
  assert.deepEqual(await pending, { accepted: false })
})

test("RpcNotifier forwards state events and notices unchanged", () => {
  const seen: unknown[] = []
  const notifier = new RpcNotifier({ state: (e) => seen.push(e), notice: (level, message) => seen.push({ level, message }) })
  const event = { modelID: "m", phase: "ready" as const, detail: "ready in 3s", elapsedSec: 3, spendUsd: 0.001, ratePerHour: 1.22, gpu: "AMPERE_48", gpuLabel: "A6000/A40 48GB" }
  notifier.state(event)
  notifier.notice("warning", "careful")
  assert.deepEqual(seen, [event, { level: "warning", message: "careful" }])
})

test("ConsoleLogger never throws on unserializable extras", () => {
  const lines: string[] = []
  const logger = new ConsoleLogger("[runpod]", (line) => lines.push(line))
  const circular: Record<string, unknown> = {}
  circular.self = circular
  logger.warn("oops", circular)
  logger.info("big", { n: 10n })
  assert.deepEqual(lines, ["[runpod] oops [unserializable extra]", "[runpod] big [unserializable extra]"])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the adapters**

`src/adapters/driven/opencode/state-store.ts`:
```ts
import type { StateStorePort } from "../../../core/ports/state-store.ts"

/** The subset of `ctx.storage` this adapter needs. */
export interface OpencodeStorageLike {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  scan(options: { prefix: string; after?: string; limit?: number }): Promise<{ entries: readonly { key: string; value: unknown }[]; next?: string }>
}

const PAGE_SIZE = 100

/** Adapts `ctx.storage` (durable, plugin-scoped JSON) to the StateStorePort. */
export class OpencodeStateStore implements StateStorePort {
  private readonly storage: OpencodeStorageLike

  constructor(storage: OpencodeStorageLike) {
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

  async keys(prefix: string): Promise<string[]> {
    const out = new Set<string>()
    const seen = new Set<string>()
    let after: string | undefined
    do {
      const page = await this.storage.scan({ prefix, after, limit: PAGE_SIZE })
      for (const entry of page.entries) out.add(entry.key)
      // Startup lists keys through here: a cursor that stops advancing must end the scan, not hang the host.
      const next = page.next
      after = next !== undefined && next !== "" && !seen.has(next) ? next : undefined
      if (after !== undefined) seen.add(after)
    } while (after !== undefined)
    return [...out].sort()
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
import type { ProvisionDecision, ProvisionProposal } from "../../../core/domain/provision.ts"
import type { ConfirmationPort } from "../../../core/ports/confirmation.ts"

interface Pending {
  resolve: (decision: ProvisionDecision) => void
  timer: unknown
}

export interface ConfirmTimers {
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (id: unknown) => void
}

/** Pairs an outgoing "please decide" request with the reply that arrives later over RPC. */
export class ConfirmBroker {
  private readonly timeoutMs: number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (id: unknown) => void
  private readonly pending = new Map<string, Pending>()

  constructor(timeoutMs: number, timers: ConfirmTimers = {}) {
    this.timeoutMs = timeoutMs
    this.setTimer =
      timers.setTimer ??
      ((fn, ms) => {
        // A pending dialog must not hold the host process open at shutdown.
        const timer = setTimeout(fn, ms) as { unref?: () => void }
        timer.unref?.()
        return timer
      })
    this.clearTimer = timers.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>))
  }

  request(issue: (requestID: string) => void): Promise<ProvisionDecision> {
    const requestID = randomUUID()
    return new Promise<ProvisionDecision>((resolve) => {
      const timer = this.setTimer(() => {
        this.pending.delete(requestID)
        resolve({ accepted: false })
      }, this.timeoutMs)
      this.pending.set(requestID, { resolve, timer })
      try {
        issue(requestID)
      } catch (error) {
        // The dialog was never shown: drop the entry and its timer now instead of at the timeout.
        this.pending.delete(requestID)
        this.clearTimer(timer)
        throw error
      }
    })
  }

  resolve(requestID: string, decision: ProvisionDecision): boolean {
    const entry = this.pending.get(requestID)
    if (!entry) return false
    this.pending.delete(requestID)
    this.clearTimer(entry.timer)
    entry.resolve(decision)
    return true
  }

  get size(): number {
    return this.pending.size
  }
}

/** ConfirmationPort over RPC: emit `confirm.requested`, wait for the `confirm` method to answer. */
export class RpcConfirmation implements ConfirmationPort {
  private readonly broker: ConfirmBroker
  private readonly emit: (requestID: string, proposal: ProvisionProposal) => void

  constructor(broker: ConfirmBroker, emit: (requestID: string, proposal: ProvisionProposal) => void) {
    this.broker = broker
    this.emit = emit
  }

  ask(proposal: ProvisionProposal): Promise<ProvisionDecision> {
    return this.broker.request((requestID) => this.emit(requestID, proposal))
  }
}
```

`src/adapters/driven/opencode/catalog-publisher.ts`:
```ts
import type { CatalogPublisherPort, PublishedModel } from "../../../core/ports/catalog-publisher.ts"

/**
 * Holds the effective model list for the provider transform (which the composition root registers)
 * and asks opencode to re-run its provider transforms whenever the list changes.
 */
export class OpencodeCatalogPublisher implements CatalogPublisherPort {
  private models: PublishedModel[] = []
  private readonly reload: () => Promise<void>

  constructor(reload: () => Promise<void>) {
    this.reload = reload
  }

  get current(): readonly PublishedModel[] {
    return this.models
  }

  /** Sets the list without a reload; used once before the provider transform is registered. */
  seed(models: readonly PublishedModel[]): void {
    this.models = copy(models)
  }

  async publish(models: readonly PublishedModel[]): Promise<void> {
    this.models = copy(models)
    await this.reload()
  }
}

function copy(models: readonly PublishedModel[]): PublishedModel[] {
  return models.map((m) => ({ config: { ...m.config, env: { ...m.config.env } }, variants: [...m.variants] }))
}
```

`src/adapters/driven/system/clock.ts`:
```ts
import type { ClockPort } from "../../../core/ports/clock.ts"

/** Service timers are advisory (idle, polls, retries, deadlines): never let one hold the host process open. */
function unref<T>(timer: T): T {
  const handle = timer as { unref?: () => void }
  handle.unref?.()
  return timer
}

export class SystemClock implements ClockPort {
  now(): number {
    return Date.now()
  }
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      unref(setTimeout(resolve, ms))
    })
  }
  setTimer(fn: () => void, ms: number): unknown {
    return unref(setTimeout(fn, ms))
  }
  clearTimer(id: unknown): void {
    clearTimeout(id as ReturnType<typeof setTimeout>)
  }
}
```

`src/adapters/driven/system/logger.ts`:
```ts
import type { LoggerPort } from "../../../core/ports/logger.ts"

/** Logging must never throw into the caller (circular objects, bigints). */
function serialize(extra: Record<string, unknown>): string {
  try {
    return JSON.stringify(extra)
  } catch {
    return "[unserializable extra]"
  }
}

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
    return `${this.prefix} ${message}${extra ? ` ${serialize(extra)}` : ""}`
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm run check`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/driven/opencode src/adapters/driven/system test/opencode-adapters.test.ts
git commit -m "feat(adapters): opencode storage/RPC/catalog adapters and system clock/logger"
```

---

### Task 12: Options resolution and `key=value` override parsing (driving adapter)

**Files:**
- Create: `src/adapters/driving/opencode/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: `ModelConfig`, `ModelOverrides`, `Settings`, `MODEL_ID_PATTERN` (core).
- Produces: `OptionsSchema`, `ModelOptionsSchema`, `OverridesSchema`, `OVERRIDE_KEYS`, `class ConfigError`, `resolveSecret(value, deps)`, `resolveSettings(raw, deps: { env?; readFile?; knownPools }): { settings; secrets: { apiKey; hfToken } }`, `parseOverrides(pairs: readonly string[]): ModelOverrides`.

- [ ] **Step 1: Write the failing test**

`test/config.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { ConfigError, OVERRIDE_KEYS, parseOverrides, resolveSecret, resolveSettings } from "../src/adapters/driving/opencode/config.ts"

const POOLS = ["AMPERE_16", "ADA_24", "AMPERE_48", "AMPERE_80"]
const resolve = (raw: unknown, env: Record<string, string> = {}) => resolveSettings(raw, { env, knownPools: POOLS })

test("defaults are applied; models keep tri-state parsers and a per-model idle timeout", () => {
  const { settings, secrets } = resolve(
    { models: { "qwen3-coder-30b": { hf: "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8", gpu: "AMPERE_48", quantization: "fp8" }, short: { hf: "Qwen/Qwen3-8B", gpu: "ADA_24", idleTimeout: 45 } } },
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
  assert.equal(settings.deleteOnExit, false)
  assert.equal(settings.adoptExisting, true)
  assert.equal(settings.maxHourlyRate, null)
  assert.deepEqual(settings.dataCenterIds, [])
  assert.equal(settings.minCudaVersion, "12.8")
  assert.equal(settings.workerImage, "runpod/worker-v1-vllm:v2.27.2")
  assert.equal(settings.flashboot, true)
  const [m, short] = settings.models
  assert.equal(m!.id, "qwen3-coder-30b")
  assert.equal(m!.name, "qwen3-coder-30b (RunPod)")
  assert.equal(m!.family, null)
  assert.equal(m!.toolParser, undefined)
  assert.equal(m!.reasoningParser, undefined)
  assert.equal(m!.quantization, "fp8")
  assert.equal(m!.context, 32768)
  assert.equal(m!.output, 8192)
  assert.equal(m!.gpuCount, 1)
  assert.equal(m!.tools, true)
  assert.equal(m!.weightsGb, null)
  assert.equal(m!.idleTimeout, null)
  assert.deepEqual(m!.env, {})
  assert.equal(short!.idleTimeout, 45)
  assert.ok(!("apiKey" in settings))
})

test("unknown gpu pool is a ConfigError naming the key and listing known pools", () => {
  assert.throws(
    () => resolve({ models: { x: { hf: "a/b", gpu: "NOPE" } } }),
    (error: unknown) => error instanceof ConfigError && /models\.x\.gpu: unknown pool "NOPE" \(known: AMPERE_16, ADA_24/.test(error.message),
  )
})

test("unknown option keys, bad model ids, bad HF ids and out-of-range idle timeouts are rejected", () => {
  assert.throws(() => resolve({ bogus: 1 }), ConfigError)
  assert.throws(() => resolve({ models: { "Bad Id": { hf: "a/b", gpu: "ADA_24" } } }), /id must match/)
  assert.throws(() => resolve({ models: { ok: { hf: "not-a-repo", gpu: "ADA_24" } } }), /hf/)
  assert.throws(() => resolve({ models: { ok: { hf: "a/b", gpu: "ADA_24", idleTimeout: 0 } } }), /idleTimeout/)
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

test("parseOverrides coerces key=value pairs into typed overrides", () => {
  assert.deepEqual(parseOverrides(["gpu=AMPERE_80", "context=8192", "tools=false", "toolParser=null", "idleTimeout=60", "weightsGb=12.5", "name=My Model"]), {
    gpu: "AMPERE_80",
    context: 8192,
    tools: false,
    toolParser: null,
    idleTimeout: 60,
    weightsGb: 12.5,
    name: "My Model",
  })
  assert.deepEqual(parseOverrides([]), {})
  assert.deepEqual(OVERRIDE_KEYS, ["name", "hf", "gpu", "gpuCount", "context", "output", "tools", "family", "toolParser", "reasoningParser", "quantization", "weightsGb", "idleTimeout"])
})

test("parseOverrides rejects malformed pairs, unknown keys and bad values with the reason", () => {
  assert.throws(() => parseOverrides(["gpu"]), /expected key=value, got "gpu"/)
  assert.throws(() => parseOverrides(["bogus=1"]), /unknown key "bogus" \(allowed: name, hf, gpu/)
  assert.throws(() => parseOverrides(["context=lots"]), /context: expected a number, got "lots"/)
  assert.throws(() => parseOverrides(["tools=yes"]), /tools: expected true or false/)
  assert.throws(() => parseOverrides(["gpu=null"]), /gpu cannot be null/)
  assert.throws(() => parseOverrides(["context=100"]), /context/)
  assert.throws(() => parseOverrides(["hf=not-a-repo"]), /hf/)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find `config.ts`.

- [ ] **Step 3: Implement `src/adapters/driving/opencode/config.ts`**

```ts
import { readFileSync } from "node:fs"
import { z } from "zod"
import { MODEL_ID_PATTERN, type ModelConfig, type ModelOverrides, type Settings } from "../../../core/domain/model.ts"

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
  idleTimeout: z.number().int().min(1).max(3600).nullable().optional(),
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
  deleteOnExit: z.boolean().default(false),
  adoptExisting: z.boolean().default(true),
  maxHourlyRate: z.number().positive().optional(),
  dataCenterIds: z.array(z.string()).default([]),
  minCudaVersion: z.string().default("12.8"),
  workerImage: z.string().default("runpod/worker-v1-vllm:v2.27.2"),
  flashboot: z.boolean().default(true),
  models: z.record(z.string(), ModelOptionsSchema).default({}),
})

/** Runtime overrides (dialog, variants, /runpod-set): same fields, no defaults, `env` excluded. */
export const OverridesSchema = z.strictObject({
  name: z.string().min(1).optional(),
  hf: z.string().regex(HF_REPO, "expected a Hugging Face repo id like org/name").optional(),
  gpu: z.string().min(1).optional(),
  gpuCount: z.number().int().min(1).max(8).optional(),
  context: z.number().int().min(1024).optional(),
  output: z.number().int().min(256).optional(),
  tools: z.boolean().optional(),
  family: z.string().nullable().optional(),
  toolParser: z.string().nullable().optional(),
  reasoningParser: z.string().nullable().optional(),
  quantization: z.string().nullable().optional(),
  weightsGb: z.number().positive().nullable().optional(),
  idleTimeout: z.number().int().min(1).max(3600).nullable().optional(),
})

export const OVERRIDE_KEYS = ["name", "hf", "gpu", "gpuCount", "context", "output", "tools", "family", "toolParser", "reasoningParser", "quantization", "weightsGb", "idleTimeout"] as const
const NUMERIC_KEYS = new Set<string>(["gpuCount", "context", "output", "weightsGb", "idleTimeout"])
const BOOLEAN_KEYS = new Set<string>(["tools"])
const NULLABLE_KEYS = new Set<string>(["family", "toolParser", "reasoningParser", "quantization", "weightsGb", "idleTimeout"])

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
    if (!MODEL_ID_PATTERN.test(id)) throw new ConfigError(`models.${id}: id must match ${MODEL_ID_PATTERN}`)
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
      idleTimeout: m.idleTimeout ?? null,
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

/** Parses `/runpod-set` style `key=value` pairs; `null` clears a nullable key. */
export function parseOverrides(pairs: readonly string[]): ModelOverrides {
  const raw: Record<string, unknown> = {}
  for (const pair of pairs) {
    const eq = pair.indexOf("=")
    if (eq <= 0) throw new ConfigError(`expected key=value, got "${pair}"`)
    const key = pair.slice(0, eq)
    const value = pair.slice(eq + 1)
    if (!(OVERRIDE_KEYS as readonly string[]).includes(key)) throw new ConfigError(`unknown key "${key}" (allowed: ${OVERRIDE_KEYS.join(", ")})`)
    if (value === "null") {
      if (!NULLABLE_KEYS.has(key)) throw new ConfigError(`${key} cannot be null`)
      raw[key] = null
      continue
    }
    if (NUMERIC_KEYS.has(key)) {
      const n = Number(value)
      if (value.trim() === "" || !Number.isFinite(n)) throw new ConfigError(`${key}: expected a number, got "${value}"`)
      raw[key] = n
      continue
    }
    if (BOOLEAN_KEYS.has(key)) {
      if (value !== "true" && value !== "false") throw new ConfigError(`${key}: expected true or false`)
      raw[key] = value === "true"
      continue
    }
    raw[key] = value
  }
  const parsed = OverridesSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    throw new ConfigError(`${issue.path.join(".") || "override"}: ${issue.message}`)
  }
  return parsed.data as ModelOverrides
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm run check`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/driving/opencode/config.ts test/config.test.ts
git commit -m "feat(opencode): resolve plugin options into settings and parse runtime key=value overrides"
```

---

### Task 13: Provider/model catalog builders (with variants) and slash commands

**Files:**
- Create: `src/adapters/driving/opencode/provider-catalog.ts`, `src/adapters/driving/opencode/commands.ts`
- Test: `test/provider-catalog.test.ts`, `test/commands.test.ts`

**Interfaces:**
- Consumes: `ModelConfig`, `PublishedModel`, `OperationsPort`, `StatusReport`, `formatStatus`, `formatModel`, `parseOverrides`, `ConfigError`.
- Produces: `PROVIDER_ID = "runpod"`, `PROVIDER_NAME`, `PROVIDER_PACKAGE`, `PLACEHOLDER_BASE_URL`, `buildProviderInfo(apiKey: string | null): Provider.Info`, `buildModelInfo(published: PublishedModel): Model.Info`; `parseArgs(text): string[]`, `registerCommands(host: CommandHost, ops: OperationsPort, reply: Reply): Promise<void>` where `CommandHost = { command: { transform(cb: (editor: { add(def: { name; description?; execute(input: { sessionID: string; prompt: { text: string } }): Promise<void> }): void }) => void): Promise<unknown> } }` and `Reply = (sessionID: string, text: string) => Promise<void>`. Commands: `runpod-status`, `runpod-up`, `runpod-down`, `runpod-add`, `runpod-set`, `runpod-remove`.

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

test("model info carries limits, tool capability, the model id as wire id and GPU pools as variants", () => {
  const model = buildModelInfo({ config: sampleModel({ name: "M", context: 40000, output: 4000, tools: false }), variants: ["AMPERE_48", "AMPERE_80"] })
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
  assert.deepEqual(model.variants.map((v) => v.id), ["AMPERE_48", "AMPERE_80"])
})
```

`test/commands.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { parseArgs, registerCommands, type CommandHost } from "../src/adapters/driving/opencode/commands.ts"
import type { StatusReport } from "../src/core/domain/events.ts"
import type { ModelConfig } from "../src/core/domain/model.ts"
import type { OperationsPort } from "../src/core/ports/driving.ts"
import { sampleModel } from "./fakes/fixtures.ts"

type Definition = { name: string; description?: string; execute(input: { sessionID: string; prompt: { text: string } }): Promise<void> }

function host() {
  const defs = new Map<string, Definition>()
  const h: CommandHost = { command: { transform: async (cb) => { cb({ add: (def) => defs.set(def.name, def) }) } } }
  return { h, defs }
}

const report: StatusReport = { models: [{ modelID: "m", phase: "ready", detail: null, spendUsd: 0.1, ratePerHour: 1.22, gpu: "AMPERE_48", gpuLabel: "A6000/A40 48GB", endpointID: "ep1", gpuCount: 1, billedUsd: null, lastRequestAt: 0, workers: null }], orphans: [] }

function ops(overrides: Partial<OperationsPort> = {}): OperationsPort & { calls: string[] } {
  const calls: string[] = []
  const added: ModelConfig = sampleModel({ id: "qwen3-8b", hf: "Qwen/Qwen3-8B", quantization: null })
  return {
    calls,
    status: async () => { calls.push("status"); return report },
    up: async (modelID) => { calls.push(`up:${modelID}`); return `https://x/${modelID}/v1` },
    down: async (modelID) => { calls.push(`down:${modelID ?? "*"}`); return modelID ? [modelID] : ["m", "n"] },
    add: async (input) => { calls.push(`add:${JSON.stringify(input)}`); return { ...added, gpu: input.gpu ?? "AMPERE_48", ...(input.overrides ?? {}) } },
    set: async (modelID, o) => { calls.push(`set:${modelID}:${JSON.stringify(o)}`); return sampleModel({ ...o, id: modelID }) },
    remove: async (modelID) => { calls.push(`remove:${modelID}`); return modelID === "m" ? "reset" : "removed" },
    models: () => [sampleModel()],
    ...overrides,
  }
}

async function run(defs: Map<string, Definition>, name: string, text: string) {
  await defs.get(name)!.execute({ sessionID: "s", prompt: { text } })
}

test("parseArgs strips the command token and splits on whitespace", () => {
  assert.deepEqual(parseArgs("/runpod-add Qwen/Qwen3-8B  AMPERE_48 context=8192"), ["Qwen/Qwen3-8B", "AMPERE_48", "context=8192"])
  assert.deepEqual(parseArgs("my-model"), ["my-model"])
  assert.deepEqual(parseArgs("/runpod-up"), [])
  assert.deepEqual(parseArgs("   "), [])
})

test("status/up/down commands reply through the reply channel", async () => {
  const { h, defs } = host()
  const o = ops()
  const replies: string[] = []
  await registerCommands(h, o, async (_sessionID, text) => { replies.push(text) })
  assert.deepEqual([...defs.keys()].sort(), ["runpod-add", "runpod-down", "runpod-remove", "runpod-set", "runpod-status", "runpod-up"])
  await run(defs, "runpod-status", "")
  assert.match(replies.at(-1)!, /^m: ready \[ep1\]/)
  await run(defs, "runpod-up", "/runpod-up m")
  assert.equal(replies.at(-1), "RunPod m is warm at https://x/m/v1")
  await run(defs, "runpod-up", "")
  assert.equal(replies.at(-1), "Usage: /runpod-up <model-id>")
  await run(defs, "runpod-down", "m")
  assert.equal(replies.at(-1), "Deleted RunPod endpoint(s): m")
  await run(defs, "runpod-down", "all")
  assert.equal(replies.at(-1), "Deleted RunPod endpoint(s): m, n")
  assert.deepEqual(o.calls, ["status", "up:m", "down:m", "down:*"])
})

test("add/set/remove commands parse their arguments and describe the effective config", async () => {
  const { h, defs } = host()
  const o = ops()
  const replies: string[] = []
  await registerCommands(h, o, async (_s, text) => { replies.push(text) })
  await run(defs, "runpod-add", "/runpod-add Qwen/Qwen3-8B AMPERE_80 context=8192 idleTimeout=60")
  assert.equal(o.calls.at(-1), 'add:{"hf":"Qwen/Qwen3-8B","gpu":"AMPERE_80","overrides":{"context":8192,"idleTimeout":60}}')
  assert.match(replies.at(-1)!, /^Added runpod\/qwen3-8b · qwen3-8b: hf=Qwen\/Qwen3-8B gpu=AMPERE_80 .*context=8192 .*idleTimeout=60\nSelect it in \/models; the first request shows the provision dialog\.$/)
  await run(defs, "runpod-add", "/runpod-add Qwen/Qwen3-8B context=4096")
  assert.equal(o.calls.at(-1), 'add:{"hf":"Qwen/Qwen3-8B","gpu":undefined,"overrides":{"context":4096}}'.replace('"gpu":undefined,', ""))
  await run(defs, "runpod-add", "")
  assert.equal(replies.at(-1), "Usage: /runpod-add <org/repo> [gpu-pool] [key=value …]")
  await run(defs, "runpod-add", "not-a-repo")
  assert.match(replies.at(-1)!, /hf/)
  await run(defs, "runpod-set", "m gpu=AMPERE_80 idleTimeout=null")
  assert.equal(o.calls.at(-1), 'set:m:{"gpu":"AMPERE_80","idleTimeout":null}')
  assert.match(replies.at(-1)!, /^Updated m: hf=.* gpu=AMPERE_80/)
  await run(defs, "runpod-set", "m")
  assert.equal(replies.at(-1), "Usage: /runpod-set <model-id> key=value [key=value …] (keys: name, hf, gpu, gpuCount, context, output, tools, family, toolParser, reasoningParser, quantization, weightsGb, idleTimeout)")
  await run(defs, "runpod-set", "m bogus=1")
  assert.match(replies.at(-1)!, /unknown key "bogus"/)
  await run(defs, "runpod-remove", "m")
  assert.equal(replies.at(-1), "Reset runpod/m to its opencode.json configuration")
  await run(defs, "runpod-remove", "qwen3-8b")
  assert.equal(replies.at(-1), "Removed runpod/qwen3-8b")
  await run(defs, "runpod-remove", "")
  assert.equal(replies.at(-1), "Usage: /runpod-remove <model-id>")
})

test("errors from the operations port are reported as text, never thrown", async () => {
  const { h, defs } = host()
  const replies: string[] = []
  await registerCommands(h, ops({ up: async () => { throw new Error("RunPod: declined") }, down: async () => [], add: async () => { throw new Error("RunPod: already exists") } }), async (_s, text) => { replies.push(text) })
  await run(defs, "runpod-up", "m")
  assert.equal(replies.at(-1), "RunPod: declined")
  await run(defs, "runpod-down", "")
  assert.equal(replies.at(-1), "No RunPod endpoints to delete")
  await run(defs, "runpod-add", "org/repo")
  assert.equal(replies.at(-1), "RunPod: already exists")
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/adapters/driving/opencode/provider-catalog.ts`**

```ts
import type { Model, Provider } from "@opencode/plugin"
import type { PublishedModel } from "../../../core/ports/catalog-publisher.ts"

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

/** GPU pools appear as selectable variants; the model.request hook receives the chosen pool as `model.variant`. */
export function buildModelInfo(published: PublishedModel): Model.Info {
  const model = published.config
  return {
    id: model.id as Model.ID,
    providerID: PROVIDER_ID as Provider.ID,
    modelID: model.id as Model.ID,
    name: model.name,
    capabilities: { tools: model.tools, input: ["text"], output: ["text"] },
    variants: published.variants.map((pool) => ({ id: pool as Model.VariantID })),
    time: { released: Date.UTC(2026, 0, 1) },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: model.context, output: model.output },
  }
}
```

If `tsc` reports that `Provider.Info`, `Model.Info` or a variant requires a field not listed, add exactly that field with its neutral value (`[]`, `{}`, `undefined` as the error allows) — never cast the whole object. If `Provider.ID`, `Model.ID` or `Model.VariantID` are not exported as types from `@opencode/plugin`, import them from `@opencode/schema/provider` / `@opencode/schema/model`.

- [ ] **Step 4: Implement `src/adapters/driving/opencode/commands.ts`**

```ts
import type { OperationsPort } from "../../../core/ports/driving.ts"
import { formatModel, formatStatus } from "../rpc/format.ts"
import { OVERRIDE_KEYS, parseOverrides } from "./config.ts"

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

/** Whitespace-separated arguments after the slash command token. */
export function parseArgs(text: string): string[] {
  return text.trim().replace(/^\/\S+\s*/, "").split(/\s+/).filter((s) => s.length > 0)
}

const SET_USAGE = `Usage: /runpod-set <model-id> key=value [key=value …] (keys: ${OVERRIDE_KEYS.join(", ")})`

export async function registerCommands(host: CommandHost, ops: OperationsPort, reply: Reply): Promise<void> {
  const guarded = (sessionID: string, action: () => Promise<string>) =>
    action().then(
      (text) => reply(sessionID, text),
      (error: unknown) => reply(sessionID, (error as Error).message),
    )

  await host.command.transform((editor) => {
    editor.add({
      name: "runpod-status",
      description: "RunPod endpoints: phase, GPU, $/h and session spend",
      execute: ({ sessionID }) => guarded(sessionID, async () => formatStatus(await ops.status())),
    })
    editor.add({
      name: "runpod-up",
      description: "Provision and warm a RunPod model without the confirm dialog: /runpod-up <model-id>",
      execute: ({ sessionID, prompt }) =>
        guarded(sessionID, async () => {
          const [modelID] = parseArgs(prompt.text)
          if (!modelID) return "Usage: /runpod-up <model-id>"
          return `RunPod ${modelID} is warm at ${await ops.up(modelID)}`
        }),
    })
    editor.add({
      name: "runpod-down",
      description: "Delete RunPod endpoint(s) and stop billing: /runpod-down [model-id|all]",
      execute: ({ sessionID, prompt }) =>
        guarded(sessionID, async () => {
          const [arg] = parseArgs(prompt.text)
          const deleted = await ops.down(arg && arg !== "all" ? arg : undefined)
          return deleted.length > 0 ? `Deleted RunPod endpoint(s): ${deleted.join(", ")}` : "No RunPod endpoints to delete"
        }),
    })
    editor.add({
      name: "runpod-add",
      description: "Add a model at runtime: /runpod-add <org/repo> [gpu-pool] [key=value …]",
      execute: ({ sessionID, prompt }) =>
        guarded(sessionID, async () => {
          const [hf, ...rest] = parseArgs(prompt.text)
          if (!hf) return "Usage: /runpod-add <org/repo> [gpu-pool] [key=value …]"
          const gpu = rest[0] !== undefined && !rest[0].includes("=") ? rest.shift() : undefined
          const overrides = parseOverrides([...(hf.includes("=") ? [hf] : []), ...rest])
          if (hf.includes("=")) return "Usage: /runpod-add <org/repo> [gpu-pool] [key=value …]"
          if (!/^[\w.-]+\/[\w.-]+$/.test(hf)) return `hf: expected a Hugging Face repo id like org/name, got "${hf}"`
          const added = await ops.add({ hf, ...(gpu === undefined ? {} : { gpu }), overrides })
          return `Added runpod/${added.id} · ${formatModel(added)}\nSelect it in /models; the first request shows the provision dialog.`
        }),
    })
    editor.add({
      name: "runpod-set",
      description: "Change a model's runtime configuration: /runpod-set <model-id> key=value …",
      execute: ({ sessionID, prompt }) =>
        guarded(sessionID, async () => {
          const [modelID, ...pairs] = parseArgs(prompt.text)
          if (!modelID || pairs.length === 0) return SET_USAGE
          const updated = await ops.set(modelID, parseOverrides(pairs))
          return `Updated ${formatModel(updated)}`
        }),
    })
    editor.add({
      name: "runpod-remove",
      description: "Remove a runtime model (and its endpoint) or reset a configured model's overrides: /runpod-remove <model-id>",
      execute: ({ sessionID, prompt }) =>
        guarded(sessionID, async () => {
          const [modelID] = parseArgs(prompt.text)
          if (!modelID) return "Usage: /runpod-remove <model-id>"
          const result = await ops.remove(modelID)
          return result === "removed" ? `Removed runpod/${modelID}` : `Reset runpod/${modelID} to its opencode.json configuration`
        }),
    })
  })
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm run check`
Expected: pass. Note the `/runpod-add` test expects the call `add:{"hf":"Qwen/Qwen3-8B","overrides":{"context":4096}}` when no pool is given (no `gpu` key at all) — the spread `...(gpu === undefined ? {} : { gpu })` produces exactly that.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/driving/opencode/provider-catalog.ts src/adapters/driving/opencode/commands.ts test/provider-catalog.test.ts test/commands.test.ts
git commit -m "feat(opencode): provider catalog with GPU variants and /runpod-* commands incl. add/set/remove"
```

---

### Task 14: Composition root — the opencode server plugin

**Files:**
- Modify: `src/adapters/driving/opencode/plugin.ts` (replace the stub)

**Interfaces:**
- Consumes: everything. Wires `EndpointService` to the adapters, registers the provider (reading the publisher's current list, so runtime changes appear after `provider.reload()`), the `model.request` hook (variant → `gpu`), the RPC methods and the commands, and returns the cleanup function.

- [ ] **Step 1: Replace `src/adapters/driving/opencode/plugin.ts`**

```ts
import { Plugin } from "@opencode/plugin"
import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import { EndpointService } from "../../../core/application/endpoint-service.ts"
import { HfWeightsInfo } from "../../driven/huggingface/weights-info.ts"
import { OpencodeCatalogPublisher } from "../../driven/opencode/catalog-publisher.ts"
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
    const publisher = new OpencodeCatalogPublisher(() => ctx.provider.reload())

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
      confirmation: new RpcConfirmation(broker, (requestID, proposal) => fire(registration?.events.emit("confirm.requested", { requestID, proposal }))),
      notifier: new RpcNotifier({
        state: (event) => fire(registration?.events.emit("state", event)),
        notice: (level, message) => fire(registration?.events.emit("notice", { level, message })),
      }),
      publisher,
      logger,
    })

    registration = await ctx.rpc.register(RunpodRpc, {
      status: async () => service.status(),
      up: async ({ modelID }) => ({ baseURL: await service.up(modelID) }),
      down: async ({ modelID }) => ({ deleted: await service.down(modelID) }),
      confirm: async ({ requestID, accepted, overrides }) => ({
        ok: broker.resolve(requestID, accepted ? { accepted: true, overrides: overrides ?? {} } : { accepted: false }),
      }),
    })

    // Static models are visible immediately; start() republishes with variants and runtime additions.
    publisher.seed(settings.models.map((config) => ({ config, variants: [] })))
    await ctx.provider.transform((editor) => {
      editor.add({ info: buildProviderInfo(secrets.apiKey), models: publisher.current.map(buildModelInfo) })
    })

    await ctx.session.hook(
      "model.request",
      async (event) => {
        const variant = event.model.variant
        event.baseURL = await service.ensureReady(event.model.id, variant === undefined ? {} : { gpu: variant })
      },
      { providerID: PROVIDER_ID },
    )

    const reply = async (sessionID: string, text: string) => {
      fire(registration?.events.emit("notice", { level: "info", message: text }))
      await ctx.session.synthetic({ sessionID, text })
    }

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

    service.start().catch((error: unknown) => logger.warn("startup failed", { error: String(error) }))

    return async () => {
      await service.stop(10_000)
      await registration?.dispose()
    }
  },
})
```

- [ ] **Step 2: Typecheck and unit tests**

Run: `npm run check`
Expected: pass. Typical fixes if tsc complains: (a) `ctx.storage` → wrap as `{ get: (k) => ctx.storage.get(k), set: (k, v) => ctx.storage.set(k, v as never), remove: (k) => ctx.storage.remove(k), scan: (o) => ctx.storage.scan(o) }`; (b) `RpcRegistration` not exported at that path → `import type { RpcRegistration } from "@opencode/plugin/promise/rpc"` is the documented `./*` subpath; if missing, declare `let registration: Awaited<ReturnType<typeof ctx.rpc.register<typeof RunpodRpc>>> | undefined`; (c) `event.model.variant` is a branded string — passing it as `gpu: string` is fine.

- [ ] **Step 3: Verify the plugin loads and registers the provider**

Run (repo root so `.opencode/opencode.jsonc` applies):
```bash
cd /Volumes/dev/projects/runpod-opencode/.claude/worktrees/feat-runpod-plugin && opencode service restart >/dev/null 2>&1; opencode models 2>&1 | grep -i runpod
```
Expected: `runpod/qwen3-0.6b` (variants, if the listing shows them, are the pool ids ≥ 16 GB: AMPERE_16, AMPERE_24, ADA_24, …). If nothing prints: `opencode --print-logs models 2>&1 | grep -iE "runpod|plugin"` and fix the reported load error (missing `node_modules`, non-erasable syntax, schema field).

- [ ] **Step 4: Verify the hook path without an API key**

In the worktree directory run `opencode`, pick `runpod/qwen3-0.6b` via `/models`, send `hi`.
Expected: the request fails with `RunPod: no API key configured — set options.apiKey or the RUNPOD_API_KEY environment variable.` (proves the `model.request` hook reaches `EndpointService`). No RunPod call is made.

- [ ] **Step 5: Verify the `/runpod-status` reply channel (spec §9.1) and runtime commands**

Still in the TUI, switch to a homelab model and run `/runpod-status`, then `/runpod-add Qwen/Qwen3-8B AMPERE_16 context=8192`, then `/models` (the new model must appear without restarting), then `/runpod-remove qwen3-8b`.
- If the reply text appears and the model does **not** start generating: keep `reply` as written.
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
git commit -m "feat(opencode): composition root wiring EndpointService, provider catalog, hook, RPC and commands"
```

---

### Task 15: TUI adapter — provision dialog loop, toasts, footer status, serverless dashboard

**Files:**
- Create: `src/adapters/driving/tui/choose.ts`, `src/adapters/driving/tui/toasts.ts`, `src/adapters/driving/tui/dashboard.ts`
- Modify: `src/adapters/driving/tui/plugin.tsx` (replace the stub)
- Test: `test/choose.test.ts`, `test/toasts.test.ts`, `test/dashboard.test.ts`

**Interfaces:**
- Consumes: `RunpodRpc`, `formatQuote`, `formatGpuOption`, `formatIdleChoice`, `footerLabel`, `phaseLabel`, `formatDuration`, `formatUsd`, `idleWindowUsd`, `StateEvent`, `ModelStatus`, `StatusReport`, `ProvisionProposal`, `ProvisionDecision`.
- Produces: `interface SelectOption<V> { title; value; description? }`, `interface DialogLike { select<V>(options: { title; placeholder?; current?: V; options: readonly SelectOption<V>[] }): Promise<V | undefined> }`, `chooseProvision(dialog: DialogLike, proposal: ProvisionProposal): Promise<ProvisionDecision>`; `interface ToastDecision { message; variant }`, `toastFor(prev: StateEvent | undefined, next: StateEvent): ToastDecision | null`; `interface DashboardRow { modelID; phase; gpu; rate; spend; workers }`, `interface DashboardView { title; rows; totals; lines: string[] }`, `dashboardView(report: StatusReport | null, live: Record<string, StateEvent>): DashboardView`.

- [ ] **Step 1: Write the failing tests**

`test/choose.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { chooseProvision, type DialogLike } from "../src/adapters/driving/tui/choose.ts"
import type { ProvisionProposal } from "../src/core/domain/provision.ts"

const proposal: ProvisionProposal = {
  quote: { modelID: "m", hf: "a/b", gpu: "AMPERE_48", gpuLabel: "A6000/A40 48GB", gpuCount: 1, ratePerHour: 1.22, rateSource: "catalog", weightsGb: 31.6, estColdStartSec: 156, idleTimeout: 120, idleWindowUsd: 0.0407, warnings: [], blocked: null },
  gpuOptions: [
    { pool: "AMPERE_16", label: "A4000/A4500 16GB", ratePerHour: 0.58, rateSource: "catalog", vramGb: 16, fits: false, estColdStartSec: 156, current: false },
    { pool: "AMPERE_48", label: "A6000/A40 48GB", ratePerHour: 1.22, rateSource: "catalog", vramGb: 48, fits: true, estColdStartSec: 156, current: true },
    { pool: "AMPERE_80", label: "A100 80GB", ratePerHour: 2.72, rateSource: "catalog", vramGb: 80, fits: true, estColdStartSec: 156, current: false },
  ],
  idleTimeoutChoices: [30, 60, 120, 300],
}

/** Answers each select() call in order; records what was shown. */
function scripted(answers: unknown[]) {
  const shown: { title: string; current: unknown; options: { title: string; value: unknown; description?: string }[] }[] = []
  const dialog: DialogLike = {
    select: async (options) => {
      shown.push({ title: options.title, current: options.current, options: options.options.map((o) => ({ title: o.title, value: o.value, description: o.description })) })
      if (answers.length === 0) throw new Error("no scripted answer")
      return answers.shift() as never
    },
  }
  return { dialog, shown }
}

test("provisioning as proposed yields an accepted decision without overrides", async () => {
  const { dialog, shown } = scripted(["go"])
  assert.deepEqual(await chooseProvision(dialog, proposal), { accepted: true, overrides: {} })
  assert.equal(shown.length, 1)
  assert.equal(shown[0]!.title, "RunPod: provision m?")
  assert.equal(shown[0]!.options[0]!.title, "Provision on A6000/A40 48GB — $1.22/h")
  assert.match(shown[0]!.options[0]!.description ?? "", /Cold start ≈ 2m 36s/)
  assert.equal(shown[0]!.options[1]!.title, "Change GPU…")
  assert.equal(shown[0]!.options[2]!.title, "Change idle timeout (120s)…")
  assert.equal(shown[0]!.options[3]!.title, "Cancel")
})

test("changing GPU and idle timeout re-prices the main option and returns both overrides", async () => {
  const { dialog, shown } = scripted(["gpu", "AMPERE_80", "idle", 60, "go"])
  assert.deepEqual(await chooseProvision(dialog, proposal), { accepted: true, overrides: { gpu: "AMPERE_80", idleTimeout: 60 } })
  assert.equal(shown[1]!.title, "GPU pool")
  assert.equal(shown[1]!.current, "AMPERE_48")
  assert.deepEqual(shown[1]!.options.map((o) => o.value), ["AMPERE_16", "AMPERE_48", "AMPERE_80"])
  assert.match(shown[1]!.options[0]!.title, /too small/)
  assert.equal(shown[2]!.options[0]!.title, "Provision on A100 80GB — $2.72/h")
  assert.equal(shown[3]!.current, 120)
  assert.deepEqual(shown[3]!.options.map((o) => o.value), [30, 60, 120, 300])
  assert.match(shown[3]!.options[1]!.title, /^1m 0s ≈ \$0\.05 per idle window$/)
  assert.equal(shown[4]!.options[2]!.title, "Change idle timeout (60s)…")
})

test("choosing the original values again yields no overrides; dismissing a sub-select keeps the previous value", async () => {
  const { dialog } = scripted(["gpu", "AMPERE_48", "idle", undefined, "go"])
  assert.deepEqual(await chooseProvision(dialog, proposal), { accepted: true, overrides: {} })
})

test("cancel or dismissing the main select declines", async () => {
  assert.deepEqual(await chooseProvision(scripted(["cancel"]).dialog, proposal), { accepted: false })
  assert.deepEqual(await chooseProvision(scripted([undefined]).dialog, proposal), { accepted: false })
})
```

`test/toasts.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { toastFor } from "../src/adapters/driving/tui/toasts.ts"
import type { StateEvent } from "../src/core/domain/events.ts"

const base: StateEvent = { modelID: "m", phase: "cold", detail: null, elapsedSec: null, spendUsd: 0, ratePerHour: 1.22, gpu: "AMPERE_48", gpuLabel: "A6000/A40 48GB" }
const at = (phase: StateEvent["phase"], extra: Partial<StateEvent> = {}): StateEvent => ({ ...base, phase, ...extra })

test("phase transitions produce the expected toasts", () => {
  assert.equal(toastFor(undefined, at("confirming")), null)
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

`test/dashboard.test.ts`:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { dashboardView } from "../src/adapters/driving/tui/dashboard.ts"
import type { StateEvent, StatusReport } from "../src/core/domain/events.ts"

const report: StatusReport = {
  models: [
    { modelID: "n", phase: "cold", detail: null, spendUsd: 0, ratePerHour: 2.72, gpu: "AMPERE_80", gpuLabel: "A100 80GB", endpointID: null, gpuCount: 1, billedUsd: null, lastRequestAt: null, workers: null },
    { modelID: "m", phase: "ready", detail: null, spendUsd: 0.42, ratePerHour: 1.22, gpu: "AMPERE_48", gpuLabel: "A6000/A40 48GB", endpointID: "ep1", gpuCount: 1, billedUsd: 0.5, lastRequestAt: 1, workers: { initializing: 0, running: 1, idle: 0, throttled: 0 } },
  ],
  orphans: [{ id: "x", name: "oc-runpod-x" }],
}
const live: Record<string, StateEvent> = {
  n: { modelID: "n", phase: "warming", detail: "starting worker", elapsedSec: 30, spendUsd: 0.01, ratePerHour: 2.72, gpu: "AMPERE_80", gpuLabel: "A100 80GB" },
}

test("dashboardView merges newer live phases into the report, sorts billing models first and totals the spend", () => {
  const view = dashboardView(report, live)
  assert.deepEqual(view.rows.map((r) => r.modelID), ["m", "n"])
  assert.deepEqual(view.rows[0], { modelID: "m", phase: "warm", gpu: "A6000/A40 48GB", rate: "$1.22/h", spend: "≈$0.42 ($0.50 billed)", workers: "1/0 wk" })
  assert.equal(view.rows[1]!.phase, "warming 30s")
  assert.equal(view.rows[1]!.spend, "≈$0.01")
  assert.equal(view.rows[1]!.workers, "")
  assert.equal(view.totals, "billing 2 · $3.94/h now · ≈$0.43 session · orphans 1")
  assert.deepEqual(view.lines, [
    "RunPod serverless",
    "m · warm · A6000/A40 48GB",
    "  $1.22/h · ≈$0.42 ($0.50 billed) · 1/0 wk",
    "n · warming 30s · A100 80GB",
    "  $2.72/h · ≈$0.01",
    "billing 2 · $3.94/h now · ≈$0.43 session · orphans 1",
  ])
})

test("a live event with the same phase as the report does not freeze the spend (report wins, live elapsed kept)", () => {
  const stale: StateEvent = { modelID: "m", phase: "ready", detail: "ready in 142s", elapsedSec: 142, spendUsd: 0.1, ratePerHour: 1.22, gpu: "AMPERE_48", gpuLabel: "A6000/A40 48GB" }
  const view = dashboardView({ models: [report.models[1]!], orphans: [] }, { m: stale })
  assert.equal(view.rows[0]!.spend, "≈$0.42 ($0.50 billed)")
  assert.equal(view.rows[0]!.phase, "warm")
  const warming = dashboardView({ models: [{ ...report.models[1]!, phase: "warming", workers: null }], orphans: [] }, { m: { ...stale, phase: "warming", elapsedSec: 57 } })
  assert.equal(warming.rows[0]!.phase, "warming 57s")
  assert.equal(warming.rows[0]!.spend, "≈$0.42 ($0.50 billed)")
})

test("dashboardView without a report or models shows a placeholder line", () => {
  assert.deepEqual(dashboardView(null, {}).lines, ["RunPod serverless", "no models configured"])
  const empty = dashboardView({ models: [], orphans: [] }, {})
  assert.deepEqual(empty.rows, [])
  assert.equal(empty.totals, "billing 0 · $0.00/h now · ≈$0.00 session")
})

test("a model starting up shows the initializing count", () => {
  const view = dashboardView({ models: [{ ...report.models[1]!, workers: { initializing: 1, running: 0, idle: 0, throttled: 0 } }], orphans: [] }, {})
  assert.equal(view.rows[0]!.workers, "0/0 wk +1 starting")
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot find `choose.ts` / `toasts.ts` / `dashboard.ts`.

- [ ] **Step 3: Implement `src/adapters/driving/tui/choose.ts`**

```ts
import type { ProvisionDecision, ProvisionOverrides, ProvisionProposal } from "../../../core/domain/provision.ts"
import { idleWindowUsd } from "../../../core/domain/quote.ts"
import { formatGpuOption, formatIdleChoice, formatQuote, formatUsd } from "../rpc/format.ts"

export interface SelectOption<V> {
  title: string
  value: V
  description?: string
}

/** The subset of `context.ui.dialog` the provisioning flow needs (so it can be tested with a scripted dialog). */
export interface DialogLike {
  select<V>(options: { title: string; placeholder?: string; current?: V; options: readonly SelectOption<V>[] }): Promise<V | undefined>
}

type Action = "go" | "gpu" | "idle" | "cancel"

/** Select-driven provisioning dialog: provision as proposed, change the GPU pool, change the idle timeout, or cancel. */
export async function chooseProvision(dialog: DialogLike, proposal: ProvisionProposal): Promise<ProvisionDecision> {
  const quote = proposal.quote
  let gpu = quote.gpu
  let idleTimeout = quote.idleTimeout
  for (;;) {
    const option = proposal.gpuOptions.find((o) => o.pool === gpu)
    const label = option?.label ?? quote.gpuLabel
    const rate = option?.ratePerHour ?? quote.ratePerHour
    const warnings = gpu === quote.gpu ? quote.warnings : option?.fits === false ? [`weights ≈${quote.weightsGb} GB may not fit ${label}`] : []
    const action = await dialog.select<Action>({
      title: `RunPod: provision ${quote.modelID}?`,
      options: [
        {
          title: `Provision on ${label} — ${formatUsd(rate)}/h`,
          value: "go",
          description: formatQuote({ ...quote, gpu, gpuLabel: label, ratePerHour: rate, rateSource: option?.rateSource ?? quote.rateSource, idleTimeout, idleWindowUsd: idleWindowUsd(rate, idleTimeout), warnings }),
        },
        { title: "Change GPU…", value: "gpu", description: `${proposal.gpuOptions.length} pools available` },
        { title: `Change idle timeout (${idleTimeout}s)…`, value: "idle", description: formatIdleChoice(idleTimeout, rate) },
        { title: "Cancel", value: "cancel" },
      ],
    })
    if (action === undefined || action === "cancel") return { accepted: false }
    if (action === "go") {
      const overrides: ProvisionOverrides = {}
      if (gpu !== quote.gpu) overrides.gpu = gpu
      if (idleTimeout !== quote.idleTimeout) overrides.idleTimeout = idleTimeout
      return { accepted: true, overrides }
    }
    if (action === "gpu") {
      const picked = await dialog.select<string>({
        title: "GPU pool",
        current: gpu,
        options: proposal.gpuOptions.map((o) => ({ title: formatGpuOption(o), value: o.pool })),
      })
      if (picked !== undefined) gpu = picked
      continue
    }
    const pickedIdle = await dialog.select<number>({
      title: "Idle timeout (the worker stays warm and billed this long after each request)",
      current: idleTimeout,
      options: proposal.idleTimeoutChoices.map((seconds) => ({ title: formatIdleChoice(seconds, rate), value: seconds })),
    })
    if (pickedIdle !== undefined) idleTimeout = pickedIdle
  }
}
```

- [ ] **Step 4: Implement `src/adapters/driving/tui/toasts.ts`**

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

- [ ] **Step 4b: Implement `src/adapters/driving/tui/dashboard.ts`**

```ts
import type { ModelStatus, StateEvent, StatusReport } from "../../../core/domain/events.ts"
import { formatUsd, phaseLabel } from "../rpc/format.ts"

export interface DashboardRow {
  modelID: string
  phase: string
  gpu: string
  rate: string
  spend: string
  workers: string
}

export interface DashboardView {
  title: string
  rows: DashboardRow[]
  totals: string
  /** Title, two lines per model, totals (or a placeholder) — one `<text>` each; sized for the narrow sidebar. */
  lines: string[]
}

const TITLE = "RunPod serverless"
/** Phases during which a worker is (or is about to be) billed. */
const BILLING_PHASES = new Set(["creating", "warming", "ready"])
const ORDER: Record<string, number> = { ready: 0, warming: 1, creating: 2, confirming: 3, deleting: 4, error: 5, idle: 6, cold: 7 }

/**
 * Merges the last status report with live state events and lays out the sidebar dashboard.
 * A live event only overrides the report when its phase differs (it is newer); otherwise the report's
 * numbers win so spend keeps moving while a model sits in `ready` (no events are emitted then).
 */
export function dashboardView(report: StatusReport | null, live: Record<string, StateEvent>): DashboardView {
  const models: ModelStatus[] = (report?.models ?? []).map((m) => {
    const e = live[m.modelID]
    return e && e.phase !== m.phase ? { ...m, phase: e.phase, detail: e.detail, spendUsd: e.spendUsd, ratePerHour: e.ratePerHour, gpu: e.gpu, gpuLabel: e.gpuLabel } : m
  })
  const sorted = [...models].sort((a, b) => (ORDER[a.phase] ?? 9) - (ORDER[b.phase] ?? 9) || (a.modelID < b.modelID ? -1 : a.modelID > b.modelID ? 1 : 0))
  const rows: DashboardRow[] = sorted.map((m) => ({
    modelID: m.modelID,
    phase: phaseLabel({ phase: m.phase, elapsedSec: live[m.modelID]?.elapsedSec ?? null }),
    gpu: m.gpuLabel,
    rate: `${formatUsd(m.ratePerHour)}/h`,
    spend: `≈${formatUsd(m.spendUsd)}${m.billedUsd !== null ? ` (${formatUsd(m.billedUsd)} billed)` : ""}`,
    workers: m.workers ? `${m.workers.running}/${m.workers.idle} wk${m.workers.initializing > 0 ? ` +${m.workers.initializing} starting` : ""}` : "",
  }))
  const billing = sorted.filter((m) => BILLING_PHASES.has(m.phase))
  const billingRate = billing.reduce((sum, m) => sum + m.ratePerHour, 0)
  const spend = models.reduce((sum, m) => sum + m.spendUsd, 0)
  const orphans = report?.orphans.length ?? 0
  const totals = `billing ${billing.length} · ${formatUsd(billingRate)}/h now · ≈${formatUsd(spend)} session${orphans > 0 ? ` · orphans ${orphans}` : ""}`
  const lines = [
    TITLE,
    ...rows.flatMap((r) => [`${r.modelID} · ${r.phase} · ${r.gpu}`, `  ${[r.rate, r.spend, r.workers].filter((s) => s.length > 0).join(" · ")}`]),
    rows.length === 0 ? "no models configured" : totals,
  ]
  return { title: TITLE, rows, totals, lines }
}
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: choose, toast and dashboard tests pass.

- [ ] **Step 6: Replace `src/adapters/driving/tui/plugin.tsx`**

```tsx
import { Plugin } from "@opencode/plugin/tui"
import { For, Show } from "solid-js"
import type { ModelStatus, StateEvent, StatusReport } from "../../../core/domain/events.ts"
import { RunpodRpc } from "../rpc/contract.ts"
import { footerLabel } from "../rpc/format.ts"
import { chooseProvision } from "./choose.ts"
import { dashboardView } from "./dashboard.ts"
import { toastFor } from "./toasts.ts"

interface TuiState {
  active: StateEvent | null
  last: Record<string, StateEvent>
  report: StatusReport | null
}

function fromStatus(m: ModelStatus): StateEvent {
  return { modelID: m.modelID, phase: m.phase, detail: m.detail, elapsedSec: null, spendUsd: m.spendUsd, ratePerHour: m.ratePerHour, gpu: m.gpu, gpuLabel: m.gpuLabel }
}

/** UI adapter: provisioning dialog, toasts, footer status line and sidebar dashboard, all fed by the server plugin's RPC. */
export default Plugin.define({
  id: "runpod.tui",
  async setup(context) {
    const rpc = context.client.rpc(RunpodRpc)
    const [state, update] = context.storage.memory<TuiState>("runpod", { initial: { active: null, last: {}, report: null } })

    /** Pulls a fresh status report. Where the report's phase equals the last live event's phase the report is newer
     *  (spend keeps accruing while `ready` without events), so it replaces the event — keeping the live elapsed time. */
    const refresh = () =>
      rpc
        .status({})
        .then((report) => {
          update((draft) => {
            draft.report = report
            for (const m of report.models) {
              const prev = draft.last[m.modelID]
              if (prev && prev.phase === m.phase) draft.last[m.modelID] = { ...fromStatus(m), elapsedSec: prev.elapsedSec }
            }
            if (draft.active) {
              const latest = draft.last[draft.active.modelID]
              if (latest) draft.active = { ...latest }
            } else {
              const known = report.models.find((m) => m.endpointID !== null) ?? report.models.find((m) => m.phase !== "cold")
              if (known) {
                const snapshot = fromStatus(known)
                draft.last[known.modelID] = snapshot
                draft.active = snapshot
              }
            }
          })
        })
        .catch(() => {
          // server plugin not registered (yet); live events will populate the views later
        })
    let debounce: ReturnType<typeof setTimeout> | null = null
    const scheduleRefresh = () => {
      if (debounce !== null) clearTimeout(debounce)
      debounce = setTimeout(() => {
        debounce = null
        void refresh()
      }, 1000)
    }

    const offConfirm = rpc.events.on("confirm.requested", async (event) => {
      const { requestID, proposal } = event.data
      const decision = await chooseProvision(context.ui.dialog, proposal)
      await rpc.confirm(decision.accepted ? { requestID, accepted: true, overrides: decision.overrides } : { requestID, accepted: false })
    })

    const offState = rpc.events.on("state", (event) => {
      const next = event.data
      const prev = state.last[next.modelID]
      const toast = toastFor(prev, next)
      update((draft) => {
        draft.last[next.modelID] = next
        draft.active = next
      })
      if (toast) context.ui.toast.show({ title: "RunPod", ...toast })
      // Only phase transitions warrant a status() round-trip; warming progress events arrive every ~3 s.
      if (prev?.phase !== next.phase) scheduleRefresh()
    })

    const offNotice = rpc.events.on("notice", (event) => {
      context.ui.toast.show({ title: "RunPod", message: event.data.message, variant: event.data.level })
    })

    const footer = () => (
      <Show when={state.active}>{(active) => <text fg={context.theme.text.muted}>{footerLabel(active())}</text>}</Show>
    )
    const unslotPrompt = context.ui.slot({ append: "prompt.footer.status", render: footer })
    const unslotHome = context.ui.slot({ append: "home.footer.status", render: footer })

    /** Sidebar dashboard next to opencode's context info: status report + live events; refreshed on phase changes and every 30 s. */
    const interval = setInterval(() => void refresh(), 30_000)
    const unslotSidebar = context.ui.slot({
      append: "sidebar.content",
      render: () => (
        <box>
          <For each={dashboardView(state.report, state.last).lines}>{(line) => <text fg={context.theme.text.muted}>{line}</text>}</For>
        </box>
      ),
    })
    void refresh()

    return () => {
      offConfirm()
      offState()
      offNotice()
      unslotPrompt()
      unslotHome()
      unslotSidebar()
      clearInterval(interval)
      if (debounce !== null) clearTimeout(debounce)
    }
  },
})
```

If `context.theme.text.muted` does not exist in `ResolvedTheme`, use `context.theme.text.base` (the token the docs show). `context.ui.dialog` satisfies `DialogLike` structurally (`select<V>(options)` → `Promise<V | undefined>`); if tsc disagrees on the option shape, pass `{ select: (o) => context.ui.dialog.select(o) }` instead.

- [ ] **Step 7: Typecheck**

Run: `npm run check`
Expected: pass (JSX is typechecked against `@opentui/solid`; the runtime transform is done by the opencode TUI host).

- [ ] **Step 8: Manual end-to-end in the TUI (real RunPod account, ≈$0.05)**

```bash
cd /Volumes/dev/projects/runpod-opencode/.claude/worktrees/feat-runpod-plugin && export RUNPOD_API_KEY=<your key> && opencode service restart >/dev/null 2>&1; opencode
```
1. `/models` → pick `runpod/qwen3-0.6b`; send `Reply with one word.`
2. Expected: select dialog "RunPod: provision qwen3-0.6b?" with *Provision on A4000/A4500 16GB — $0.58/h* (description = quote), *Change GPU…*, *Change idle timeout (60s)…*, *Cancel*. Open *Change GPU…* (every pool priced, fits flags), go back, choose *Provision*.
3. Expected toasts: "Provisioning qwen3-0.6b on A4000/A4500 16GB · $0.58/h", "Cold start of qwen3-0.6b…", progress every 30 s, then "qwen3-0.6b ready in …"; the answer streams in; footer shows `runpod A4000/A4500 16GB · warm · $0.58/h · ≈$0.0x`. The sidebar shows the `RunPod serverless` block under opencode's context/usage section (toggle the sidebar if hidden): `qwen3-0.6b · warm · A4000/A4500 16GB`, then `  $0.58/h · ≈$… · 1/0 wk` once health reports a running worker, and the `billing 1 · $0.58/h now · ≈$… session` totals line. It updates about 1 s after each phase change and every 30 s; the spend on the second line keeps increasing while the model stays warm. If the block does not render in the sidebar, note what "context view" should mean for the user (fallback: a `session.panel` contribution) and continue.
4. `/runpod-status` → one line with `[<endpointID>]`, session ≈$, and (after a minute) billed $.
5. Wait ~75 s idle → toast "qwen3-0.6b scaled to zero · ≈$… this session", footer says `cold`.
6. Send another message → "Cold start of qwen3-0.6b…" without a dialog → answer.
7. In `/models` pick the same model with a different variant (e.g. `AMPERE_24`) and send a message → expected: a notice that the configuration changed and the endpoint is deleted, then the provision dialog for the new pool with its price.
8. `/runpod-set qwen3-0.6b idleTimeout=30` → reply shows `idleTimeout=30`; `/runpod-status` unchanged endpoint id (patched, not recreated).
9. `/runpod-down qwen3-0.6b` → reply "Deleted RunPod endpoint(s): qwen3-0.6b"; confirm in the RunPod console that no `oc-runpod-*` endpoint remains.
10. Provision once more, quit the TUI, run `opencode service stop`, then start opencode again in the same directory and run `/runpod-status`: with the default `deleteOnExit: false` the endpoint must still exist and be reported as `idle` (re-adopted). Then set `"deleteOnExit": true` in `.opencode/opencode.jsonc`, restart the service, provision, `opencode service stop`, and verify in the console that the endpoint is gone. Restore the dev config afterwards.

- [ ] **Step 9: Commit**

```bash
git add src/adapters/driving/tui test/choose.test.ts test/toasts.test.ts test/dashboard.test.ts
git commit -m "feat(tui): provisioning dialog with GPU/idle choices, state toasts, footer status and sidebar dashboard"
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
    keys: async (prefix) => [...store.keys()].filter((k) => k.startsWith(prefix)).sort(),
  },
  clock,
  confirmation: { ask: async () => ({ accepted: true, overrides: {} }) },
  notifier: {
    state: (e) => console.log(`[${e.phase}] ${e.detail ?? ""} ≈$${e.spendUsd.toFixed(3)}`),
    notice: (level, message) => console.log(level, message),
  },
  publisher: { publish: async (models) => console.log("catalog:", models.map((m) => `${m.config.id} [${m.variants.join(", ")}]`).join("; ")) },
  logger: new ConsoleLogger("[smoke]"),
})

const started = Date.now()
try {
  await service.start()
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
Run: `RUNPOD_API_KEY=… npm run smoke`. Expected: `catalog: smoke-qwen3-0.6b [AMPERE_16, AMPERE_24, …]`, phases `creating → warming (progress) → ready`, `chat 200 …`, `deleted [ "smoke-qwen3-0.6b" ]`, session spend well under $0.10. Fix any RunPod payload mismatch discovered here (list envelope key, billing shape) in `http.ts` with a matching unit test.

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
        "deleteOnExit": false, // default: idle endpoints cost $0 and are re-used next session; /runpod-down deletes explicitly
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
            "output": 16384,
            "idleTimeout": 300
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
created lazily on first use, scaled to zero when idle, and configurable at runtime.

- Pick `runpod/<model>` in `/models`. The first request opens a dialog: **Provision on <GPU> — $/h** (with the
  full quote: rate, estimated cold start, idle window cost), **Change GPU…** (every pool priced, fits / too small),
  **Change idle timeout…**, **Cancel**. Nothing is created before you choose *Provision*.
- GPU pools also appear as **variants** of each model in `/models`: selecting one provisions on that pool.
- The endpoint uses `workers.min = 0`: after the idle timeout RunPod stops the worker and billing stops. The next
  request re-warms it (no dialog).
- Toasts show provisioning, cold-start progress, readiness, scale-down and deletion with the running spend; the
  footer shows `runpod <gpu> · warm|cold · $/h · ≈$spent`; the sidebar has a **RunPod serverless** dashboard (one row
  per model: phase, GPU, $/h, session ≈$ and billed $, live running/idle workers; totals line with the $/h billing now).
- Endpoints are **kept** between sessions by default (zero workers cost $0) and re-adopted at start; set
  `deleteOnExit: true` to delete them when opencode shuts down. Stale endpoints of a configured model (config
  changed) are replaced automatically; endpoints of models no longer configured are only reported.

## Commands

| command | effect |
|---|---|
| `/runpod-status` | phase, endpoint id, GPU, $/h, session spend, billed $ per model; unmanaged `oc-runpod-*` endpoints |
| `/runpod-up <model>` | provision + warm without the dialog |
| `/runpod-down [model\|all]` | scale to zero and delete |
| `/runpod-add <org/repo> [gpu-pool] [key=value …]` | add a model at runtime; without a pool the cheapest pool whose VRAM fits the weights is chosen |
| `/runpod-set <model> key=value …` | change `gpu`, `gpuCount`, `context`, `output`, `idleTimeout`, `quantization`, `tools`, `family`, `toolParser`, `reasoningParser`, `weightsGb`, `name`, `hf` (`null` clears nullable keys) |
| `/runpod-remove <model>` | runtime model: delete it and its endpoint; configured model: reset runtime overrides |

Runtime changes (dialog choices, variants, `/runpod-set`, `/runpod-add`) persist in opencode's plugin storage and
survive restarts; `opencode.json` stays the source of the static defaults. A change that alters the endpoint
configuration (pool, context, parsers, …) deletes the live endpoint; the next request re-provisions with a dialog.
Changing only the idle timeout patches the live endpoint.

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
| `confirm` | `true` | show the provision dialog before creating an endpoint |
| `confirmTimeoutSec` | `120` | unanswered dialog counts as declined |
| `idleTimeout` | `120` | default seconds a worker stays warm (billed) after a request; per model via `models.<id>.idleTimeout` |
| `workersMax` | `1` | parallel workers per endpoint |
| `executionTimeoutSec` | `600` | per-request cap on RunPod |
| `coldStartTimeoutSec` | `600` | give up warming after this |
| `deleteOnExit` | `false` | delete owned endpoints on shutdown |
| `adoptExisting` | `true` | reuse an `oc-runpod-*` endpoint whose config hash matches |
| `maxHourlyRate` | – | refuse provisioning above this $/h |
| `dataCenterIds` | `[]` | pin regions, e.g. `["EU-RO-1"]` |
| `minCudaVersion` | `"12.8"` | host CUDA floor |
| `workerImage` | `runpod/worker-v1-vllm:v2.27.2` | vLLM worker image |
| `flashboot` | `true` | RunPod FlashBoot |
| `models.<id>` | – | `hf`, `gpu` (pool id), `gpuCount`, `context`, `output`, `tools`, `family`, `toolParser`, `reasoningParser`, `quantization`, `weightsGb`, `idleTimeout`, `env` |

GPU pools and static fallback prices: `AMPERE_16` $0.58 · `AMPERE_24` $0.69 · `ADA_24` $1.10 · `ADA_32_PRO` $1.58 ·
`AMPERE_48` $1.22 · `ADA_48_PRO` $1.75 · `AMPERE_80` $2.72 · `ADA_80_PRO` $4.79 · `BLACKWELL_96` $3.49 · `HOPPER_141` $5.93
(live prices come from RunPod's catalog when available).

## Cost model

You pay RunPod per second while a worker runs: cold start (image + weights load), your requests, and the idle window
after each request. Zero workers cost nothing. Endpoint records live in opencode's plugin storage; the config hash
`OPENCODE_RUNPOD_HASH` on each endpoint lets the plugin recognise, reuse or replace them.

## Caveats

- The first request after a cold start waits for the worker (minutes for 30B-class models). The request timeout is
  raised to 10 minutes for this provider.
- opencode runs a background service; `deleteOnExit` (when enabled) fires when the service disposes the plugin
  (`opencode service stop|restart`, location shutdown), not necessarily when you close the TUI.
- Two opencode locations loading the plugin adopt the same endpoints by name; endpoints of models one location does
  not know are reported as orphans, never deleted automatically.

## Development

Hexagonal layout: `src/core` (domain + `EndpointService`, ports only), `src/adapters/driven` (RunPod, vLLM recipe,
Hugging Face, opencode storage/RPC/catalog, system), `src/adapters/driving` (opencode plugin, TUI, RPC contract).

```sh
npm install
npm run check          # tsc + node:test (includes the architecture rule test)
RUNPOD_API_KEY=... npm run smoke   # real endpoint, ~$0.05
```
Dev config: `.opencode/opencode.jsonc` loads this checkout with a tiny test model when opencode runs in this directory.
```

Adjust the caveat about TUI exit to what Task 15 step 8.10 observed.

- [ ] **Step 4: Typecheck, tests, commit**

Run: `npm run check`
```bash
git add scripts/smoke.ts README.md examples/opencode.jsonc
git commit -m "docs: README, example config and real-API smoke script"
```

- [ ] **Step 5: Install into the user's global opencode config (manual, user-owned file)**

Add to `~/.config/opencode/opencode.json` (JSON, no comments) a `plugins` entry pointing at the checkout, with the
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
