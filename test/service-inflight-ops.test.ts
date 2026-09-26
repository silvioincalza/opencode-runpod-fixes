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
