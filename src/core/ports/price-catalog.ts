import type { PoolRate } from "../domain/quote.ts"

export interface PriceCatalogPort {
  rate(pool: string): Promise<PoolRate>
  knownPools(): readonly string[]
}
