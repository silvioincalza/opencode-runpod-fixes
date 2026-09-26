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
