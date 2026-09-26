import type { EndpointSpec } from "../domain/endpoint.ts"

export interface RemoteEndpoint {
  id: string
  name: string
  /** Value of the config-hash marker on the remote endpoint, or null when absent. */
  hash: string | null
}

export interface HealthSnapshot {
  initializing: number
  running: number
  idle: number
  throttled: number
}

export type ComputeErrorKind = "transient" | "fatal"

/** Thrown by compute adapters. `fatal` stops warm-up retries (e.g. HTTP 4xx other than 408/429). */
export class ComputeError extends Error {
  readonly kind: ComputeErrorKind
  readonly status: number | null
  constructor(message: string, kind: ComputeErrorKind, status: number | null = null) {
    super(message)
    this.name = "ComputeError"
    this.kind = kind
    this.status = status
  }
}

export interface ComputeProviderPort {
  list(): Promise<RemoteEndpoint[]>
  create(spec: EndpointSpec): Promise<{ id: string }>
  scaleToZero(id: string): Promise<void>
  /** Deleting an already-deleted endpoint resolves normally. */
  delete(id: string): Promise<void>
  health(id: string): Promise<HealthSnapshot>
  /** Forces a cold worker to boot and resolves once it answered a request. */
  warmup(id: string, modelID: string, signal: AbortSignal): Promise<void>
  /** Log tail of an unhealthy worker, or null when nothing useful is available. */
  diagnostics(id: string): Promise<string | null>
  /** Changes the idle window of a live endpoint without recreating it. */
  setIdleTimeout(id: string, seconds: number): Promise<void>
  billedUsd(id: string): Promise<number | null>
  inferenceBaseURL(id: string): string
}
