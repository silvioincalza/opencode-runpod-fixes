import type { EndpointSpec } from "../../src/core/domain/endpoint.ts"
import type { ComputeProviderPort, HealthSnapshot, RemoteEndpoint } from "../../src/core/ports/compute-provider.ts"

interface PendingWarmup {
  resolve: () => void
  reject: (error: Error) => void
}

export class FakeCompute implements ComputeProviderPort {
  remote: RemoteEndpoint[] = []
  created: EndpointSpec[] = []
  calls: string[] = []
  healthSnapshot: HealthSnapshot = { initializing: 0, running: 0, idle: 0, throttled: 0 }
  healthGate: Promise<void> | null = null
  diagnosticsText: string | null = null
  billed: number | null = null
  failCreate: Error | null = null
  failDelete: Error | null = null
  private warmups: PendingWarmup[] = []
  private nextId = 1

  async list(): Promise<RemoteEndpoint[]> {
    this.calls.push("list")
    return this.remote.map((e) => ({ ...e }))
  }

  async create(spec: EndpointSpec): Promise<{ id: string }> {
    this.calls.push(`create:${spec.name}`)
    if (this.failCreate) throw this.failCreate
    this.created.push(spec)
    const id = `ep${this.nextId++}`
    this.remote.push({ id, name: spec.name, hash: spec.hash })
    return { id }
  }

  async scaleToZero(id: string): Promise<void> {
    this.calls.push(`scaleToZero:${id}`)
  }

  async delete(id: string): Promise<void> {
    this.calls.push(`delete:${id}`)
    if (this.failDelete) throw this.failDelete
    this.remote = this.remote.filter((e) => e.id !== id)
  }

  async health(id: string): Promise<HealthSnapshot> {
    this.calls.push(`health:${id}`)
    if (this.healthGate) await this.healthGate
    return { ...this.healthSnapshot }
  }

  warmup(id: string, _modelID: string, signal: AbortSignal): Promise<void> {
    this.calls.push(`warmup:${id}`)
    return new Promise<void>((resolve, reject) => {
      const entry: PendingWarmup = { resolve, reject }
      this.warmups.push(entry)
      signal.addEventListener(
        "abort",
        () => {
          this.warmups = this.warmups.filter((w) => w !== entry)
          reject(new Error("aborted"))
        },
        { once: true },
      )
    })
  }

  async diagnostics(id: string): Promise<string | null> {
    this.calls.push(`diagnostics:${id}`)
    return this.diagnosticsText
  }

  async setIdleTimeout(id: string, seconds: number): Promise<void> {
    this.calls.push(`setIdleTimeout:${id}:${seconds}`)
  }

  async billedUsd(): Promise<number | null> {
    return this.billed
  }

  inferenceBaseURL(id: string): string {
    return `https://compute.test/${id}/v1`
  }

  get pendingWarmups(): number {
    return this.warmups.length
  }

  finishWarmup(): void {
    const w = this.warmups.shift()
    if (!w) throw new Error("no pending warm-up")
    w.resolve()
  }

  failWarmup(error: Error): void {
    const w = this.warmups.shift()
    if (!w) throw new Error("no pending warm-up")
    w.reject(error)
  }
}
