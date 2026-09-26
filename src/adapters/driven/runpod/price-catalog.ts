import type { PoolRate } from "../../../core/domain/quote.ts"
import type { ClockPort } from "../../../core/ports/clock.ts"
import type { PriceCatalogPort } from "../../../core/ports/price-catalog.ts"
import { POOLS } from "./pools.ts"
import type { GpuCatalogEntry } from "./types.ts"

export const CATALOG_TTL_MS = 10 * 60_000

export class RunpodPriceCatalog implements PriceCatalogPort {
  private readonly http: { catalogGpus(): Promise<GpuCatalogEntry[]> } | null
  private readonly clock: ClockPort
  private readonly ttlMs: number
  private cache: { at: number; entries: GpuCatalogEntry[] | null } | null = null

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
    const live = entries?.find((e) => e.pool === pool && typeof e.price?.serverless === "number")
    if (live) return { ratePerHour: live.price!.serverless!, source: "catalog", vramGb: live.memory ?? info?.vramGb ?? null, label: info?.label ?? pool }
    return { ratePerHour: info?.fallbackUsdPerHour ?? 0, source: "fallback", vramGb: info?.vramGb ?? null, label: info?.label ?? pool }
  }

  private async entries(): Promise<GpuCatalogEntry[] | null> {
    if (!this.http) return null
    const now = this.clock.now()
    if (this.cache && now - this.cache.at <= this.ttlMs) return this.cache.entries
    let entries: GpuCatalogEntry[] | null = null
    try {
      entries = await this.http.catalogGpus()
    } catch {
      entries = null // remembered for one TTL so a broken catalog is not hammered
    }
    this.cache = { at: now, entries }
    return entries
  }
}
