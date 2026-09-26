import { idleTimeoutFor, type ModelConfig, type Settings } from "./model.ts"

export interface PoolRate {
  /** $/h for ONE GPU of the pool. */
  ratePerHour: number
  source: "catalog" | "fallback"
  vramGb: number | null
  label: string
}

export interface Quote {
  modelID: string
  hf: string
  gpu: string
  gpuLabel: string
  gpuCount: number
  /** $/h for the whole worker (pool rate × gpuCount). */
  ratePerHour: number
  rateSource: "catalog" | "fallback"
  weightsGb: number | null
  estColdStartSec: number
  idleTimeout: number
  idleWindowUsd: number
  warnings: string[]
  /** Non-null when provisioning must be refused. */
  blocked: string | null
}

export const DEFAULT_WEIGHTS_GB = 60
/** Fraction of VRAM the weights may occupy; the rest is KV cache and activations. */
export const FIT_FACTOR = 0.85

/** Heuristic: ~45 s container/engine start + ~3.5 s per GB pulled and loaded. Unknown size → 3 min. */
export function estimateColdStartSec(weightsGb: number | null): number {
  return weightsGb === null ? 180 : Math.round(45 + weightsGb * 3.5)
}

export function idleWindowUsd(ratePerHour: number, idleTimeoutSec: number): number {
  return Math.round(((ratePerHour * idleTimeoutSec) / 3600) * 1e6) / 1e6
}

/** true/false when both sizes are known, null otherwise. */
export function fitsPool(weightsGb: number | null, vramGb: number | null, gpuCount: number): boolean | null {
  if (weightsGb === null || vramGb === null) return null
  return weightsGb <= vramGb * gpuCount * FIT_FACTOR
}

export function buildQuote(input: { model: ModelConfig; settings: Settings; rate: PoolRate; weightsGb: number | null }): Quote {
  const { model, settings, rate, weightsGb } = input
  const ratePerHour = Math.round(rate.ratePerHour * model.gpuCount * 1e4) / 1e4
  const idleTimeout = idleTimeoutFor(model, settings)
  const warnings: string[] = []
  let blocked: string | null = null
  if (rate.source === "fallback") warnings.push("price from the static table (live catalog unavailable)")
  if (weightsGb === null) warnings.push("weights size unknown; the cold start estimate is a guess")
  if (fitsPool(weightsGb, rate.vramGb, model.gpuCount) === false) {
    warnings.push(`weights ≈${weightsGb} GB may not fit ${rate.vramGb! * model.gpuCount} GB of VRAM`)
  }
  if (rate.ratePerHour === 0) blocked = `no price known for GPU pool "${model.gpu}"`
  if (settings.maxHourlyRate !== null && ratePerHour > settings.maxHourlyRate) {
    blocked = `$${ratePerHour.toFixed(2)}/h exceeds options.maxHourlyRate $${settings.maxHourlyRate.toFixed(2)}`
  }
  return {
    modelID: model.id,
    hf: model.hf,
    gpu: model.gpu,
    gpuLabel: rate.label,
    gpuCount: model.gpuCount,
    ratePerHour,
    rateSource: rate.source,
    weightsGb,
    estColdStartSec: estimateColdStartSec(weightsGb),
    idleTimeout,
    idleWindowUsd: idleWindowUsd(ratePerHour, idleTimeout),
    warnings,
    blocked,
  }
}
