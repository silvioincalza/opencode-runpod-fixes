import { test } from "node:test"
import assert from "node:assert/strict"
import { RunpodPriceCatalog } from "../src/adapters/driven/runpod/price-catalog.ts"
import { POOLS } from "../src/adapters/driven/runpod/pools.ts"
import { FakeClock } from "./fakes/clock.ts"

function http(entries: unknown[] | Error) {
  let calls = 0
  return {
    calls: () => calls,
    catalogGpus: async () => {
      calls++
      if (entries instanceof Error) throw entries
      return entries as { id: string; pool?: string; memory?: number; price?: { serverless?: number } }[]
    },
  }
}

test("live catalog price wins and is labelled from the pool table", async () => {
  const h = http([{ id: "NVIDIA A40", pool: "AMPERE_48", memory: 48, price: { serverless: 1.3 } }])
  const catalog = new RunpodPriceCatalog(h, new FakeClock())
  assert.deepEqual(await catalog.rate("AMPERE_48"), { ratePerHour: 1.3, source: "catalog", vramGb: 48, label: "A6000/A40 48GB" })
})

test("missing pool in the live catalog falls back to the static table; unknown pool → 0", async () => {
  const catalog = new RunpodPriceCatalog(http([]), new FakeClock())
  assert.deepEqual(await catalog.rate("ADA_48_PRO"), { ratePerHour: 1.75, source: "fallback", vramGb: 48, label: "L40/L40S/6000Ada 48GB" })
  assert.deepEqual(await catalog.rate("NOPE"), { ratePerHour: 0, source: "fallback", vramGb: null, label: "NOPE" })
})

test("no http (no API key) and catalog errors both use the static table", async () => {
  const offline = new RunpodPriceCatalog(null, new FakeClock())
  assert.equal((await offline.rate("AMPERE_16")).ratePerHour, 0.58)
  const failing = new RunpodPriceCatalog(http(new Error("down")), new FakeClock())
  assert.equal((await failing.rate("AMPERE_16")).source, "fallback")
})

test("the live catalog is cached for the TTL and refreshed afterwards", async () => {
  const clock = new FakeClock()
  const h = http([{ id: "x", pool: "AMPERE_16", price: { serverless: 0.6 } }])
  const catalog = new RunpodPriceCatalog(h, clock, 1000)
  await catalog.rate("AMPERE_16")
  await catalog.rate("AMPERE_48")
  assert.equal(h.calls(), 1)
  await clock.advance(1001)
  await catalog.rate("AMPERE_16")
  assert.equal(h.calls(), 2)
})

test("knownPools lists the static table", () => {
  const catalog = new RunpodPriceCatalog(null, new FakeClock())
  assert.deepEqual([...catalog.knownPools()].sort(), Object.keys(POOLS).sort())
})
