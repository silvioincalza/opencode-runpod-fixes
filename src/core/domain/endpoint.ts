import { createHash } from "node:crypto"
import { idleTimeoutFor, type ModelConfig, type Settings } from "./model.ts"

export type Phase = "cold" | "confirming" | "creating" | "warming" | "ready" | "idle" | "deleting" | "error"

/** Container recipe produced by a WorkerRecipePort. `secretEnv` is never hashed or logged. */
export interface WorkerRecipe {
  image: string
  env: Record<string, string>
  secretEnv: Record<string, string>
  diskGb: number
}

export interface EndpointSpec {
  name: string
  modelID: string
  recipe: WorkerRecipe
  gpu: { pool: string; count: number; minCudaVersion: string }
  workers: { min: number; max: number; idleTimeoutSec: number }
  executionTimeoutSec: number
  flashboot: boolean
  dataCenterIds: string[]
  /** Configuration fingerprint; stored on the remote endpoint so reconcile can compare. */
  hash: string
}

export interface EndpointRecord {
  endpointID: string
  name: string
  modelID: string
  gpu: string
  gpuCount: number
  hash: string
  createdAt: number
  spendUsd: number
}

export const ENDPOINT_PREFIX = "oc-runpod-"

export function endpointName(modelID: string): string {
  return `${ENDPOINT_PREFIX}${modelID}`
}

export function modelIDFromName(name: string): string | null {
  if (!name.startsWith(ENDPOINT_PREFIX)) return null
  const id = name.slice(ENDPOINT_PREFIX.length)
  return id.length > 0 ? id : null
}

export function specHash(input: { image: string; env: Record<string, string>; gpu: { pool: string; count: number; minCudaVersion: string } }): string {
  return createHash("sha256").update(stableJson(input)).digest("hex").slice(0, 16)
}

export function specHashFor(model: ModelConfig, settings: Settings, recipe: WorkerRecipe): string {
  return specHash({
    image: recipe.image,
    env: recipe.env,
    gpu: { pool: model.gpu, count: model.gpuCount, minCudaVersion: settings.minCudaVersion },
  })
}

export function buildEndpointSpec(model: ModelConfig, settings: Settings, recipe: WorkerRecipe): EndpointSpec {
  return {
    name: endpointName(model.id),
    modelID: model.id,
    recipe,
    gpu: { pool: model.gpu, count: model.gpuCount, minCudaVersion: settings.minCudaVersion },
    workers: { min: 0, max: settings.workersMax, idleTimeoutSec: idleTimeoutFor(model, settings) },
    executionTimeoutSec: settings.executionTimeoutSec,
    flashboot: settings.flashboot,
    dataCenterIds: [...settings.dataCenterIds],
    hash: specHashFor(model, settings, recipe),
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`
  }
  return JSON.stringify(value)
}
