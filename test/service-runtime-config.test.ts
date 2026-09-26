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
