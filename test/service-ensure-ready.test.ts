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
