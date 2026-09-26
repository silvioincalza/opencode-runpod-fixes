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
