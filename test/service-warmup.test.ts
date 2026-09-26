import { test } from "node:test"
import assert from "node:assert/strict"
import { HEALTH_POLL_MS, IDLE_GRACE_MS, WARMUP_RETRY_MS } from "../src/core/application/endpoint-service.ts"
import { ComputeError } from "../src/core/ports/compute-provider.ts"
import { flush } from "./fakes/clock.ts"
import { harness } from "./fakes/fixtures.ts"

/** Returns the in-flight promise wrapped in an object so the async helper does not adopt (and wait for) it. */
async function startWarming(h: ReturnType<typeof harness>) {
  const pending = h.service.ensureReady("m")
  await flush()
  assert.equal(h.service.phase("m"), "warming")
  return { pending }
}

test("health polling emits progress with elapsed seconds while warming", async () => {
  const h = harness()
  const { pending } = await startWarming(h)
  h.compute.healthSnapshot = { initializing: 1, running: 0, idle: 0, throttled: 0 }
  await h.clock.advance(HEALTH_POLL_MS)
  const progress = h.notifier.events.at(-1)!
  assert.equal(progress.phase, "warming")
  assert.match(progress.detail ?? "", /initializing 1 · running 0/)
  assert.equal(progress.elapsedSec, 3)
  h.compute.finishWarmup()
  await pending
  const ready = h.notifier.events.at(-1)!
  assert.equal(ready.phase, "ready")
  assert.equal(ready.elapsedSec, 3)
  assert.match(ready.detail ?? "", /ready in 3s/)
  await h.clock.advance(HEALTH_POLL_MS) // poller exits quietly after abort
  assert.equal(h.notifier.events.at(-1)!.phase, "ready")
})

test("transient warm-up errors are retried after WARMUP_RETRY_MS", async () => {
  const h = harness()
  const { pending } = await startWarming(h)
  h.compute.failWarmup(new ComputeError("502 Bad Gateway", "transient", 502))
  await flush()
  assert.equal(h.compute.pendingWarmups, 0)
  await h.clock.advance(WARMUP_RETRY_MS)
  assert.equal(h.compute.pendingWarmups, 1)
  h.compute.finishWarmup()
  await pending
  assert.equal(h.compute.calls.filter((c) => c.startsWith("warmup:")).length, 2)
  assert.equal(h.service.phase("m"), "ready")
})

test("fatal warm-up errors stop immediately, keep the endpoint and stop the meter", async () => {
  const h = harness()
  const { pending } = await startWarming(h)
  h.compute.failWarmup(new ComputeError("RunPod 400 Bad Request: model not found", "fatal", 400))
  await assert.rejects(pending, /cold start of m failed after 0s: RunPod 400 Bad Request: model not found.*Endpoint ep1 was kept/s)
  assert.equal(h.service.phase("m"), "cold")
  assert.equal(h.compute.calls.filter((c) => c.startsWith("delete:")).length, 0)
  assert.equal(h.notifier.events.at(-1)!.spendUsd, 0)
  assert.notEqual(await h.store.get("endpoints/m"), undefined)
})

test("cold start timeout aborts, includes worker diagnostics, and a retry re-warms without re-confirming", async () => {
  const h = harness({ coldStartTimeoutSec: 60 })
  h.compute.diagnosticsText = "CUDA out of memory\nworker exited"
  const { pending } = await startWarming(h)
  const rejected = assert.rejects(pending, /timed out after 60s.*Worker log tail:\nCUDA out of memory\nworker exited/s)
  await h.clock.advance(60_000)
  await rejected
  assert.equal(h.service.phase("m"), "cold")
  const retry = h.service.ensureReady("m")
  await flush()
  assert.equal(h.confirmation.asked.length, 1) // no second dialog
  assert.equal(h.compute.created.length, 1) // no second endpoint
  h.compute.finishWarmup()
  assert.equal(await retry, "https://compute.test/ep1/v1")
})

test("idle detection stops the meter at lastRequest + idleTimeout and the next request re-warms", async () => {
  const h = harness()
  const { pending } = await startWarming(h)
  await h.clock.advance(3_000)
  h.compute.finishWarmup()
  await pending
  // ready at t=3s; meter running at $1.22/h since t=0
  await h.clock.advance(120_000 + IDLE_GRACE_MS)
  assert.equal(h.service.phase("m"), "idle")
  const idle = h.notifier.events.at(-1)!
  assert.equal(idle.phase, "idle")
  const expected = (1.22 * (3_000 + 120_000)) / 3_600_000
  assert.ok(Math.abs(idle.spendUsd - Math.round(expected * 1000) / 1000) < 1e-9, `spend ${idle.spendUsd}`)
  const stored = await h.store.get<{ spendUsd: number }>("endpoints/m")
  assert.equal(stored?.spendUsd, idle.spendUsd)
  const again = h.service.ensureReady("m")
  await flush()
  assert.equal(h.service.phase("m"), "warming")
  assert.equal(h.confirmation.asked.length, 1)
  assert.equal(h.compute.created.length, 1)
  h.compute.finishWarmup()
  await again
  assert.equal(h.service.phase("m"), "ready")
})

test("requests during the idle window keep the worker counted as warm; a per-model idle timeout is honoured", async () => {
  const h = harness()
  const { pending } = await startWarming(h)
  h.compute.finishWarmup()
  await pending
  await h.clock.advance(100_000)
  await h.service.ensureReady("m") // touches lastRequestAt at t=100s
  await h.clock.advance(100_000) // t=200s: only 100s since last request → still ready
  assert.equal(h.service.phase("m"), "ready")
  await h.clock.advance(20_000 + IDLE_GRACE_MS)
  assert.equal(h.service.phase("m"), "idle")

  const short = harness({ models: [{ ...h.settings.models[0]!, idleTimeout: 30 }] })
  const s = await startWarming(short)
  short.compute.finishWarmup()
  await s.pending
  assert.equal(short.compute.created[0]!.workers.idleTimeoutSec, 30)
  await short.clock.advance(30_000 + IDLE_GRACE_MS)
  assert.equal(short.service.phase("m"), "idle")
})
