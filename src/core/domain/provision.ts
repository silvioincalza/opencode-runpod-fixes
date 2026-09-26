import type { ModelConfig } from "./model.ts"
import { estimateColdStartSec, fitsPool, type PoolRate, type Quote } from "./quote.ts"

export interface GpuOption {
  pool: string
  label: string
  /** $/h for the whole worker (pool rate × gpuCount). */
  ratePerHour: number
  rateSource: "catalog" | "fallback"
  vramGb: number | null
  fits: boolean | null
  estColdStartSec: number
  current: boolean
}

/** What the user sees before an endpoint is created: the quote plus every alternative. */
export interface ProvisionProposal {
  quote: Quote
  gpuOptions: GpuOption[]
  idleTimeoutChoices: number[]
}

export interface ProvisionOverrides {
  gpu?: string
  idleTimeout?: number
}

export type ProvisionDecision = { accepted: false } | { accepted: true; overrides: ProvisionOverrides }

export const IDLE_TIMEOUT_CHOICES: readonly number[] = [30, 60, 120, 300, 600, 1800]

export interface PoolPricing {
  pool: string
  rate: PoolRate
}

const byPrice = (a: { ratePerHour: number; pool: string }, b: { ratePerHour: number; pool: string }) =>
  a.ratePerHour - b.ratePerHour || (a.pool < b.pool ? -1 : a.pool > b.pool ? 1 : 0)

export function buildGpuOptions(model: ModelConfig, pricing: readonly PoolPricing[], weightsGb: number | null): GpuOption[] {
  return pricing
    .filter((p) => p.rate.ratePerHour > 0)
    .map(({ pool, rate }) => ({
      pool,
      label: rate.label,
      ratePerHour: Math.round(rate.ratePerHour * model.gpuCount * 1e4) / 1e4,
      rateSource: rate.source,
      vramGb: rate.vramGb,
      fits: fitsPool(weightsGb, rate.vramGb, model.gpuCount),
      estColdStartSec: estimateColdStartSec(weightsGb),
      current: pool === model.gpu,
    }))
    .sort(byPrice)
}

export function buildProposal(input: { quote: Quote; model: ModelConfig; pricing: readonly PoolPricing[]; weightsGb: number | null }): ProvisionProposal {
  return {
    quote: input.quote,
    gpuOptions: buildGpuOptions(input.model, input.pricing, input.weightsGb),
    idleTimeoutChoices: [...IDLE_TIMEOUT_CHOICES],
  }
}

/** Variant pools for the model picker: at least the current pool's VRAM (all pools when unknown), cheapest first. */
export function gpuVariantsFor(model: ModelConfig, pricing: readonly PoolPricing[]): string[] {
  const floor = pricing.find((p) => p.pool === model.gpu)?.rate.vramGb ?? null
  return pricing
    .filter((p) => p.rate.ratePerHour > 0 && (p.pool === model.gpu || floor === null || (p.rate.vramGb ?? 0) >= floor))
    .map((p) => ({ pool: p.pool, ratePerHour: p.rate.ratePerHour }))
    .sort(byPrice)
    .map((p) => p.pool)
}
