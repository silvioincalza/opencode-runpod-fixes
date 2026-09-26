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
