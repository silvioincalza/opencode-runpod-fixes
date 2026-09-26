import { test } from "node:test"
import assert from "node:assert/strict"
import { ENDPOINT_PREFIX, buildEndpointSpec, endpointName, modelIDFromName, specHash, specHashFor, type WorkerRecipe } from "../src/core/domain/endpoint.ts"
import { findModel, type ModelConfig, type Settings } from "../src/core/domain/model.ts"

const model: ModelConfig = { id: "m", name: "M", hf: "Qwen/Qwen3-8B", gpu: "AMPERE_48", gpuCount: 2, context: 32768, output: 8192, tools: true, family: null, toolParser: undefined, reasoningParser: undefined, quantization: null, weightsGb: null, idleTimeout: null, env: {} }
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
  assert.equal(buildEndpointSpec({ ...model, idleTimeout: 45 }, settings, recipe).workers.idleTimeoutSec, 45)
})

test("findModel", () => {
  assert.equal(findModel(settings, "m"), model)
  assert.equal(findModel(settings, "nope"), undefined)
})
