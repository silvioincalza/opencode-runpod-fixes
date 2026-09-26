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
