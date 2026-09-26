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
