import type { Phase } from "./endpoint.ts"

export interface StateEvent {
  modelID: string
  phase: Phase
  detail: string | null
  elapsedSec: number | null
  spendUsd: number
  /** $/h for the whole worker (pool rate × gpuCount). */
  ratePerHour: number
  gpu: string
  gpuLabel: string
}

export type NoticeLevel = "info" | "warning" | "error"

export interface ModelStatus {
  modelID: string
  phase: Phase
  detail: string | null
  spendUsd: number
  ratePerHour: number
  gpu: string
  gpuLabel: string
  endpointID: string | null
  gpuCount: number
  billedUsd: number | null
  lastRequestAt: number | null
}

export interface StatusReport {
  models: ModelStatus[]
  orphans: { id: string; name: string }[]
}
