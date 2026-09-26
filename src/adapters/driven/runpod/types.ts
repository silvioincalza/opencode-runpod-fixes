export interface CreateEndpointRequest {
  name: string
  type: "QUEUE"
  scaling: { type: "QUEUE_DELAY"; queueDelay: number }
  gpu: { pools: string[]; count: number; minCudaVersion?: string }
  image: string
  env: Record<string, string>
  disk: number
  workers: { min: number; max: number; idleTimeout: number }
  /** Per-request execution timeout in milliseconds. */
  timeout: number
  flashboot: "OFF" | "FLASHBOOT"
  dataCenterIds?: string[]
}

export interface EndpointPatch {
  workers?: { min?: number; max?: number; idleTimeout?: number }
  env?: Record<string, string>
}

export interface EndpointInfo {
  id: string
  name: string
  env?: Record<string, string>
  image?: string
  workers?: { min: number; max: number; idleTimeout?: number }
  gpu?: { pools?: string[]; count?: number }
  createdAt?: string
}

export interface WorkerInfo {
  id: string
  status: string
  gpuTypeId?: string
  dataCenterId?: string
}

export interface HealthInfo {
  jobs: { completed: number; failed: number; inProgress: number; inQueue: number; retried: number }
  workers: { idle: number; initializing: number; ready: number; running: number; throttled: number }
}

export interface GpuCatalogEntry {
  id: string
  pool?: string
  memory?: number
  price?: { secure?: number; community?: number; serverless?: number }
}
