import type { PoolRate } from "../../../core/domain/quote.ts"
import type { ClockPort } from "../../../core/ports/clock.ts"
import type { PriceCatalogPort } from "../../../core/ports/price-catalog.ts"
import { POOLS } from "./pools.ts"
import type { GpuCatalogEntry } from "./types.ts"

export const CATALOG_TTL_MS = 10 * 60_000
/** A failed lookup is retried after this long: a broken catalog is not hammered, but a blip does not pin fallback prices for a full TTL. */
export const CATALOG_FAILURE_TTL_MS = 60_000

export class RunpodPriceCatalog implements PriceCatalogPort {
  private readonly http: { catalogGpus(): Promise<GpuCatalogEntry[]> } | null
  private readonly clock: ClockPort
  private readonly ttlMs: number
  private cache: { at: number; entries: GpuCatalogEntry[] | null } | null = null
  private pending: Promise<GpuCatalogEntry[] | null> | null = null

  constructor(http: { catalogGpus(): Promise<GpuCatalogEntry[]> } | null, clock: ClockPort, ttlMs: number = CATALOG_TTL_MS) {
    this.http = http
    this.clock = clock
    this.ttlMs = ttlMs
  }

  knownPools(): readonly string[] {
    return Object.keys(POOLS)
  }

  async rate(pool: string): Promise<PoolRate> {
    const info = POOLS[pool]
    const entries = await this.entries()
    const live = entries?.find((e) => e.pool === pool && (e.price?.serverless ?? 0) > 0)
    // The pool id fixes the VRAM; the live catalog's `memory` is only a fallback for pools missing from the table.
    if (live) return { ratePerHour: live.price!.serverless!, source: "catalog", vramGb: info?.vramGb ?? live.memory ?? null, label: info?.label ?? pool }
    return { ratePerHour: info?.fallbackUsdPerHour ?? 0, source: "fallback", vramGb: info?.vramGb ?? null, label: info?.label ?? pool }
  }

  private entries(): Promise<GpuCatalogEntry[] | null> {
    const http = this.http
    if (!http) return Promise.resolve(null)
    const now = this.clock.now()
    if (this.cache) {
      const ttl = this.cache.entries === null ? Math.min(CATALOG_FAILURE_TTL_MS, this.ttlMs) : this.ttlMs
      if (now - this.cache.at <= ttl) return Promise.resolve(this.cache.entries)
    }
    // Concurrent callers share one lookup, so a slow failure can never overwrite a fresh success.
    if (!this.pending) {
      this.pending = http
        .catalogGpus()
        .catch(() => null)
        .then((entries) => {
          this.cache = { at: now, entries }
          return entries
        })
        .finally(() => {
          this.pending = null
        })
    }
    return this.pending
  }
}
