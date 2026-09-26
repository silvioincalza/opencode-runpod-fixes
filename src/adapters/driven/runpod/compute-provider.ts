import type { EndpointSpec } from "../../../core/domain/endpoint.ts"
import { ComputeError, type ComputeProviderPort, type HealthSnapshot, type RemoteEndpoint } from "../../../core/ports/compute-provider.ts"
import { RunpodError, type RunpodHttpLike } from "./http.ts"
import type { CreateEndpointRequest } from "./types.ts"

export const MARKER_ENV = "OPENCODE_RUNPOD"
export const HASH_ENV = "OPENCODE_RUNPOD_HASH"
const LOG_TAIL_LINES = 40

export function toCreateBody(spec: EndpointSpec): CreateEndpointRequest {
  const env: Record<string, string> = { ...spec.recipe.env, ...spec.recipe.secretEnv }
  env[MARKER_ENV] = "1"
  env[HASH_ENV] = spec.hash
  const body: CreateEndpointRequest = {
    name: spec.name,
    type: "QUEUE",
    scaling: { type: "QUEUE_DELAY", queueDelay: 1 },
    gpu: { pools: [spec.gpu.pool], count: spec.gpu.count },
    image: spec.recipe.image,
    env,
    disk: spec.recipe.diskGb,
    workers: { min: spec.workers.min, max: spec.workers.max, idleTimeout: spec.workers.idleTimeoutSec },
    timeout: spec.executionTimeoutSec * 1000,
    flashboot: spec.flashboot ? "FLASHBOOT" : "OFF",
  }
  if (spec.gpu.minCudaVersion) body.gpu.minCudaVersion = spec.gpu.minCudaVersion
  if (spec.dataCenterIds.length > 0) body.dataCenterIds = [...spec.dataCenterIds]
  return body
}

export class RunpodComputeProvider implements ComputeProviderPort {
  private readonly http: RunpodHttpLike

  constructor(http: RunpodHttpLike) {
    this.http = http
  }

  async list(): Promise<RemoteEndpoint[]> {
    const endpoints = await this.http.listEndpoints()
    return endpoints.map((ep) => ({ id: ep.id, name: ep.name, hash: ep.env?.[HASH_ENV] ?? null }))
  }

  async create(spec: EndpointSpec): Promise<{ id: string }> {
    const created = await this.http.createEndpoint(toCreateBody(spec))
    return { id: created.id }
  }

  async scaleToZero(id: string): Promise<void> {
    await this.http.patchEndpoint(id, { workers: { min: 0, max: 0 } })
  }

  async setIdleTimeout(id: string, seconds: number): Promise<void> {
    await this.http.patchEndpoint(id, { workers: { idleTimeout: seconds } })
  }

  async delete(id: string): Promise<void> {
    try {
      await this.http.deleteEndpoint(id)
    } catch (error) {
      if (error instanceof RunpodError && error.status === 404) return
      throw error
    }
  }

  async health(id: string): Promise<HealthSnapshot> {
    const info = await this.http.health(id)
    return { initializing: info.workers.initializing, running: info.workers.running, idle: info.workers.idle, throttled: info.workers.throttled }
  }

  async warmup(id: string, modelID: string, signal: AbortSignal): Promise<void> {
    try {
      await this.http.chatCompletion(id, { model: modelID, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }, signal)
    } catch (error) {
      if (error instanceof RunpodError) {
        const fatal = error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429
        throw new ComputeError(error.message, fatal ? "fatal" : "transient", error.status)
      }
      throw new ComputeError((error as Error).message ?? String(error), "transient", null)
    }
  }

  async diagnostics(id: string): Promise<string | null> {
    try {
      const workers = await this.http.listWorkers(id)
      const unhealthy = workers.find((w) => w.status.toUpperCase() === "UNHEALTHY")
      if (!unhealthy) return null
      const text = (await this.http.workerLogs(id, unhealthy.id)).replace(/\r\n?/g, "\n").trim()
      return text ? text.split("\n").slice(-LOG_TAIL_LINES).join("\n") : null
    } catch {
      return null // best effort: the caller is already reporting a failed cold start
    }
  }

  billedUsd(id: string): Promise<number | null> {
    return this.http.billedUsd(id)
  }

  inferenceBaseURL(id: string): string {
    return this.http.openaiBaseURL(id)
  }
}
