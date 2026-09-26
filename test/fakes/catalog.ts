import type { PoolRate } from "../../src/core/domain/quote.ts"
import type { PriceCatalogPort } from "../../src/core/ports/price-catalog.ts"

export class FakeCatalog implements PriceCatalogPort {
  rates: Record<string, PoolRate> = {
    AMPERE_16: { ratePerHour: 0.58, source: "catalog", vramGb: 16, label: "A4000/A4500 16GB" },
    AMPERE_48: { ratePerHour: 1.22, source: "catalog", vramGb: 48, label: "A6000/A40 48GB" },
    AMPERE_80: { ratePerHour: 2.72, source: "catalog", vramGb: 80, label: "A100 80GB" },
  }
  fail = false
  calls = 0

  async rate(pool: string): Promise<PoolRate> {
    this.calls++
    if (this.fail) throw new Error("catalog down")
    return this.rates[pool] ?? { ratePerHour: 0, source: "fallback", vramGb: null, label: pool }
  }

  knownPools(): readonly string[] {
    return Object.keys(this.rates)
  }
}
