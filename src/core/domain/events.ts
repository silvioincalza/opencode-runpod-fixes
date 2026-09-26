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

/** Live worker counts of a provisioned endpoint (running workers are the ones being billed). */
export interface WorkerCounts {
  initializing: number
  running: number
  idle: number
  throttled: number
}

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
  /** From a best-effort health call; null when not provisioned or the call failed. */
  workers: WorkerCounts | null
}

export interface StatusReport {
  models: ModelStatus[]
  orphans: { id: string; name: string }[]
}
