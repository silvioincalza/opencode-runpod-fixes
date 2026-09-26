export interface ModelConfig {
  id: string
  name: string
  /** Hugging Face repo id, e.g. "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8". */
  hf: string
  /** Compute pool identifier (RunPod serverless pool id such as "AMPERE_48"). */
  gpu: string
  gpuCount: number
  context: number
  output: number
  tools: boolean
  /** Explicit model family (e.g. "qwen3-coder") or null → the worker recipe may infer it from `hf`. */
  family: string | null
  /** undefined → recipe preset; null → disabled; string → explicit parser name. */
  toolParser: string | null | undefined
  reasoningParser: string | null | undefined
  quantization: string | null
  weightsGb: number | null
  /** Per-model idle window in seconds; null → Settings.idleTimeout. */
  idleTimeout: number | null
  env: Record<string, string>
}

export interface Settings {
  confirm: boolean
  confirmTimeoutSec: number
  idleTimeout: number
  workersMax: number
  executionTimeoutSec: number
  coldStartTimeoutSec: number
  deleteOnExit: boolean
  adoptExisting: boolean
  maxHourlyRate: number | null
  dataCenterIds: string[]
  minCudaVersion: string
  workerImage: string
  flashboot: boolean
  models: ModelConfig[]
}

export function findModel(settings: Settings, modelID: string): ModelConfig | undefined {
  return settings.models.find((m) => m.id === modelID)
}

export const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/

/** Everything but the id may be changed at runtime (dialog, variants, /runpod-set). */
export type ModelOverrides = Partial<Omit<ModelConfig, "id">>

export function idleTimeoutFor(model: ModelConfig, settings: Settings): number {
  return model.idleTimeout ?? settings.idleTimeout
}

/** Returns a new config; `undefined` values mean "not overridden"; `env` is copied. */
export function applyOverrides(model: ModelConfig, overrides: ModelOverrides): ModelConfig {
  const next: Record<string, unknown> = { ...model }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue
    next[key] = key === "env" ? { ...(value as Record<string, string>) } : value
  }
  return next as unknown as ModelConfig
}

/** "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8" → "qwen3-coder-30b-a3b-instruct-fp8" */
export function deriveModelID(hf: string): string {
  const name = hf.split("/").pop() ?? hf
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 63)
    .replace(/[-._]+$/, "")
  if (!MODEL_ID_PATTERN.test(id)) throw new Error(`cannot derive a model id from ${JSON.stringify(hf)}`)
  return id
}
