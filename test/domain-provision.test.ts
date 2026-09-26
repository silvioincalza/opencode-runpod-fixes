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
