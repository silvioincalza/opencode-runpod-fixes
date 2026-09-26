import { test } from "node:test"
import assert from "node:assert/strict"
import { OpencodeCatalogPublisher } from "../src/adapters/driven/opencode/catalog-publisher.ts"
import { ConfirmBroker, RpcConfirmation } from "../src/adapters/driven/opencode/confirmation.ts"
import { RpcNotifier } from "../src/adapters/driven/opencode/notifier.ts"
import { OpencodeStateStore } from "../src/adapters/driven/opencode/state-store.ts"
import { SystemClock } from "../src/adapters/driven/system/clock.ts"
import { ConsoleLogger } from "../src/adapters/driven/system/logger.ts"
import type { ProvisionProposal } from "../src/core/domain/provision.ts"
import type { Quote } from "../src/core/domain/quote.ts"
import type { PublishedModel } from "../src/core/ports/catalog-publisher.ts"
import { sampleModel } from "./fakes/fixtures.ts"

function timers() {
  const pending: { id: number; fn: () => void }[] = []
  let seq = 0
  return {
    pending,
    setTimer: (fn: () => void, _ms: number) => { const id = ++seq; pending.push({ id, fn }); return id },
    clearTimer: (id: unknown) => { const i = pending.findIndex((t) => t.id === id); if (i >= 0) pending.splice(i, 1) },
    fire: () => { const t = pending.shift(); t?.fn() },
  }
}

const quote: Quote = { modelID: "m", hf: "a/b", gpu: "AMPERE_48", gpuLabel: "A6000/A40 48GB", gpuCount: 1, ratePerHour: 1.22, rateSource: "catalog", weightsGb: 10, estColdStartSec: 80, idleTimeout: 120, idleWindowUsd: 0.04, warnings: [], blocked: null }
const proposal: ProvisionProposal = { quote, gpuOptions: [], idleTimeoutChoices: [30, 60] }

test("ConfirmBroker: accept with overrides, decline, unknown id, timeout", async () => {
  const t = timers()
  const broker = new ConfirmBroker(1000, t)
  let issued = ""
  const accepted = broker.request((id) => { issued = id })
  assert.ok(issued.length > 0)
  assert.equal(broker.size, 1)
  assert.equal(broker.resolve("nope", { accepted: true, overrides: {} }), false)
  assert.equal(broker.resolve(issued, { accepted: true, overrides: { gpu: "AMPERE_80" } }), true)
  assert.deepEqual(await accepted, { accepted: true, overrides: { gpu: "AMPERE_80" } })
  assert.equal(broker.size, 0)
  assert.equal(t.pending.length, 0)

  const declined = broker.request((id) => { issued = id })
  broker.resolve(issued, { accepted: false })
  assert.deepEqual(await declined, { accepted: false })

  const timedOut = broker.request((id) => { issued = id })
  t.fire()
  assert.deepEqual(await timedOut, { accepted: false })
  assert.equal(broker.resolve(issued, { accepted: true, overrides: {} }), false)
})

test("RpcConfirmation emits the proposal with the request id and resolves through the broker", async () => {
  const t = timers()
  const broker = new ConfirmBroker(1000, t)
  const emitted: { requestID: string; proposal: ProvisionProposal }[] = []
  const confirmation = new RpcConfirmation(broker, (requestID, p) => { emitted.push({ requestID, proposal: p }) })
  const pending = confirmation.ask(proposal)
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0]!.proposal, proposal)
  assert.equal(broker.resolve(emitted[0]!.requestID, { accepted: true, overrides: { idleTimeout: 60 } }), true)
  assert.deepEqual(await pending, { accepted: true, overrides: { idleTimeout: 60 } })
})

test("RpcNotifier forwards state and notices", () => {
  const seen: string[] = []
  const notifier = new RpcNotifier({ state: (e) => seen.push(`state:${e.phase}`), notice: (level, message) => seen.push(`${level}:${message}`) })
  notifier.state({ modelID: "m", phase: "ready", detail: null, elapsedSec: 1, spendUsd: 0, ratePerHour: 1, gpu: "g", gpuLabel: "G" })
  notifier.notice("warning", "careful")
  assert.deepEqual(seen, ["state:ready", "warning:careful"])
})

test("OpencodeCatalogPublisher keeps the latest list (copied) and triggers a provider reload", async () => {
  let reloads = 0
  const publisher = new OpencodeCatalogPublisher(async () => { reloads++ })
  assert.deepEqual(publisher.current, [] as PublishedModel[])
  publisher.seed([{ config: sampleModel({ id: "seeded" }), variants: [] }])
  assert.equal(reloads, 0)
  assert.equal(publisher.current[0]!.config.id, "seeded")
  const model = sampleModel()
  await publisher.publish([{ config: model, variants: ["AMPERE_48", "AMPERE_80"] }])
  assert.equal(reloads, 1)
  assert.equal(publisher.current.length, 1)
  assert.deepEqual(publisher.current[0]!.variants, ["AMPERE_48", "AMPERE_80"])
  model.gpu = "CHANGED"
  assert.equal(publisher.current[0]!.config.gpu, "AMPERE_48")
})

test("OpencodeStateStore passes through to ctx.storage and lists keys across scan pages", async () => {
  const backing = new Map<string, unknown>()
  const store = new OpencodeStateStore({
    get: async (key) => backing.get(key),
    set: async (key, value) => { backing.set(key, value) },
    remove: async (key) => { backing.delete(key) },
    scan: async ({ prefix, after, limit }) => {
      const keys = [...backing.keys()].filter((k) => k.startsWith(prefix)).sort()
      const start = after ? keys.indexOf(after) + 1 : 0
      const page = keys.slice(start, start + (limit ?? 100))
      const next = start + page.length < keys.length ? page.at(-1) : undefined
      return { entries: page.map((key) => ({ key, value: backing.get(key) })), next }
    },
  })
  await store.set("models/a", { a: 1 })
  await store.set("models/b", { b: 2 })
  await store.set("models/c", { c: 3 })
  await store.set("other/x", 1)
  assert.deepEqual(await store.get<{ a: number }>("models/a"), { a: 1 })
  assert.deepEqual(await store.keys("models/"), ["models/a", "models/b", "models/c"])
  await store.remove("models/a")
  assert.equal(await store.get("models/a"), undefined)
  assert.deepEqual(await store.keys("models/"), ["models/b", "models/c"])
})

test("SystemClock and ConsoleLogger are usable", async () => {
  const clock = new SystemClock()
  const before = clock.now()
  const id = clock.setTimer(() => {}, 10_000)
  clock.clearTimer(id)
  await clock.sleep(1)
  assert.ok(clock.now() >= before)
  const lines: string[] = []
  const logger = new ConsoleLogger("[t]", (line) => lines.push(line))
  logger.info("hello", { a: 1 })
  logger.warn("oops")
  assert.deepEqual(lines, ['[t] hello {"a":1}', "[t] oops"])
})

test("SystemClock timers never hold the process open", async () => {
  const clock = new SystemClock()
  const id = clock.setTimer(() => {}, 10_000) as { hasRef?: () => boolean }
  assert.equal(id.hasRef?.(), false)
  clock.clearTimer(id)
  await clock.sleep(5) // an unref'd sleep still resolves
})
