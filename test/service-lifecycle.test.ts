import { test } from "node:test"
import assert from "node:assert/strict"
import { BILLING_TTL_MS, EndpointService, IDLE_GRACE_MS } from "../src/core/application/endpoint-service.ts"
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
