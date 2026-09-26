import type { CreateEndpointRequest, EndpointInfo, EndpointPatch, GpuCatalogEntry, HealthInfo, WorkerInfo } from "./types.ts"

export const API_BASE = "https://api.runpod.io/v2"
export const RUNTIME_BASE = "https://api.runpod.ai/v2"

export class RunpodError extends Error {
  readonly status: number
  readonly title: string
  readonly detail: string | null
  constructor(status: number, title: string, detail: string | null, context: string) {
    super(`RunPod ${status} ${title}${detail ? `: ${detail}` : ""} (${context})`)
    this.name = "RunpodError"
    this.status = status
    this.title = title
    this.detail = detail
  }
}

export interface RunpodClientOptions {
  apiKey: string
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  apiBase?: string
  runtimeBase?: string
  maxRetries?: number
}

export interface ChatCompletionBody {
  model: string
  messages?: { role: string; content: string }[]
  max_tokens?: number
  stream?: boolean
}

interface RequestInitLike {
  signal?: AbortSignal
  text?: boolean
  /** false for requests that must not be re-sent after an ambiguous failure (network error or 5xx): only 429 is retried. */
  idempotent?: boolean
}

export class RunpodHttp {
  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly apiBase: string
  private readonly runtimeBase: string
  private readonly maxRetries: number

  constructor(options: RunpodClientOptions) {
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetch ?? fetch
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.apiBase = (options.apiBase ?? API_BASE).replace(/\/+$/, "")
    this.runtimeBase = (options.runtimeBase ?? RUNTIME_BASE).replace(/\/+$/, "")
    this.maxRetries = options.maxRetries ?? 3
  }

  openaiBaseURL(endpointId: string): string {
    return `${this.runtimeBase}/${endpointId}/openai/v1`
  }

  async listEndpoints(): Promise<EndpointInfo[]> {
    const out: EndpointInfo[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    for (let pages = 1; ; pages++) {
      const url = `${this.apiBase}/serverless${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`
      const page = await this.request<unknown>("GET", url)
      out.push(...extractItems<EndpointInfo>(page))
      const next = nextCursor(page)
      if (next === undefined) return out
      if (seen.has(next)) throw new Error(`RunPod: endpoint listing repeated cursor ${JSON.stringify(next)}`)
      if (pages >= MAX_PAGES) throw new Error(`RunPod: endpoint listing exceeded ${MAX_PAGES} pages`)
      seen.add(next)
      cursor = next
    }
  }

  createEndpoint(body: CreateEndpointRequest): Promise<EndpointInfo> {
    // A retried create after a lost response would leave a duplicate endpoint.
    return this.request<EndpointInfo>("POST", `${this.apiBase}/serverless`, body, { idempotent: false })
  }

  getEndpoint(id: string): Promise<EndpointInfo> {
    return this.request<EndpointInfo>("GET", `${this.apiBase}/serverless/${id}`)
  }

  patchEndpoint(id: string, patch: EndpointPatch): Promise<EndpointInfo> {
    return this.request<EndpointInfo>("PATCH", `${this.apiBase}/serverless/${id}`, patch)
  }

  async deleteEndpoint(id: string): Promise<void> {
    await this.request<unknown>("DELETE", `${this.apiBase}/serverless/${id}`)
  }

  async listWorkers(id: string): Promise<WorkerInfo[]> {
    return extractItems<WorkerInfo>(await this.request<unknown>("GET", `${this.apiBase}/serverless/${id}/workers`))
  }

  async workerLogs(id: string, workerId: string): Promise<string> {
    const raw = await this.request<string>("GET", `${this.apiBase}/serverless/${id}/workers/${workerId}/logs`, undefined, { text: true })
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return raw
    }
    return linesOf(parsed)
  }

  async catalogGpus(): Promise<GpuCatalogEntry[]> {
    return extractItems<GpuCatalogEntry>(await this.request<unknown>("GET", `${this.apiBase}/catalog/gpus?product=SERVERLESS`))
  }

  /** Best-effort actual spend for one endpoint; null when the payload has no recognisable totals. */
  async billedUsd(endpointId: string): Promise<number | null> {
    const page = await this.request<unknown>("GET", `${this.apiBase}/billing/serverless?endpointId=${encodeURIComponent(endpointId)}`)
    const amounts = extractItems<{ totalAmount?: unknown }>(page)
      .map((r) => r.totalAmount)
      .filter((v): v is number => typeof v === "number")
    if (amounts.length > 0) return Math.round(amounts.reduce((a, b) => a + b, 0) * 1e6) / 1e6
    const total = (page as { metadata?: { totals?: { totalAmount?: unknown } } } | null)?.metadata?.totals?.totalAmount
    return typeof total === "number" ? total : null
  }

  async health(endpointId: string): Promise<HealthInfo> {
    const raw = (await this.request<Partial<HealthInfo> | null>("GET", `${this.runtimeBase}/${endpointId}/health`)) ?? {}
    const w: Partial<HealthInfo["workers"]> = raw.workers ?? {}
    const j: Partial<HealthInfo["jobs"]> = raw.jobs ?? {}
    return {
      jobs: { completed: j.completed ?? 0, failed: j.failed ?? 0, inProgress: j.inProgress ?? 0, inQueue: j.inQueue ?? 0, retried: j.retried ?? 0 },
      workers: { idle: w.idle ?? 0, initializing: w.initializing ?? 0, ready: w.ready ?? 0, running: w.running ?? 0, throttled: w.throttled ?? 0 },
    }
  }

  async chatCompletion(endpointId: string, body: ChatCompletionBody, signal: AbortSignal): Promise<unknown> {
    return this.request<unknown>("POST", `${this.openaiBaseURL(endpointId)}/chat/completions`, body, { signal })
  }

  private async request<T>(method: string, url: string, body?: unknown, init: RequestInitLike = {}): Promise<T> {
    const context = `${method} ${url}`
    for (let attempt = 0; ; attempt++) {
      let response: Response
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", accept: "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: init.signal,
        })
      } catch (error) {
        // A network error is ambiguous — the server may have acted — so a non-idempotent request is never re-sent.
        if (init.signal?.aborted || init.idempotent === false || attempt >= this.maxRetries) throw error
        await this.sleep(1000 * 2 ** attempt)
        continue
      }
      if (response.status === 429 || (response.status >= 500 && init.idempotent !== false)) {
        if (attempt >= this.maxRetries) throw await this.toError(response, context)
        await response.body?.cancel().catch(() => {})
        await this.sleep(1000 * 2 ** attempt)
        continue
      }
      if (!response.ok) throw await this.toError(response, context)
      if (response.status === 204) return undefined as T
      const text = await response.text()
      if (init.text) return text as T
      if (!text) return undefined as T
      try {
        return JSON.parse(text) as T
      } catch {
        // Never echo the body: it is server text and could carry anything, the API key included.
        throw new RunpodError(response.status, "invalid JSON response", null, context)
      }
    }
  }

  private async toError(response: Response, context: string): Promise<RunpodError> {
    let title = response.statusText || "error"
    let detail: string | null = null
    try {
      const problem = (await response.json()) as { title?: unknown; detail?: unknown; message?: unknown }
      if (typeof problem.title === "string") title = problem.title
      if (typeof problem.detail === "string") detail = problem.detail
      else if (typeof problem.message === "string") detail = problem.message
    } catch {
      // non-JSON error body: keep the status text
    }
    return new RunpodError(response.status, this.redact(title), detail === null ? null : this.redact(detail), context)
  }

  /** Error bodies come from the server; never let them carry the API key into messages, logs or toasts. */
  private redact(text: string): string {
    return this.apiKey.length > 0 ? text.split(this.apiKey).join("[redacted]") : text
  }
}

export type RunpodHttpLike = Pick<
  RunpodHttp,
  "openaiBaseURL" | "listEndpoints" | "createEndpoint" | "getEndpoint" | "patchEndpoint" | "deleteEndpoint" | "listWorkers" | "workerLogs" | "catalogGpus" | "billedUsd" | "health" | "chatCompletion"
>

const ITEM_KEYS = ["data", "items", "endpoints", "results", "workers", "gpus", "records"] as const

/** Upper bound on pages followed by listEndpoints: a server that never stops paginating must not hang startup. */
const MAX_PAGES = 100

function extractItems<T>(page: unknown): T[] {
  if (Array.isArray(page)) return page as T[]
  if (page && typeof page === "object") {
    for (const key of ITEM_KEYS) {
      const value = (page as Record<string, unknown>)[key]
      if (Array.isArray(value)) return value as T[]
    }
  }
  return []
}

function nextCursor(page: unknown): string | undefined {
  const pagination = (page as { pagination?: { nextCursor?: unknown; hasNextPage?: unknown } } | null)?.pagination
  if (!pagination || pagination.hasNextPage === false) return undefined
  return typeof pagination.nextCursor === "string" && pagination.nextCursor ? pagination.nextCursor : undefined
}

function linesOf(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return value.map((line) => (typeof line === "string" ? line : String((line as { message?: unknown })?.message ?? JSON.stringify(line)))).join("\n")
  }
  if (value && typeof value === "object") {
    for (const key of ["logs", "lines", "data"]) {
      const inner = (value as Record<string, unknown>)[key]
      if (Array.isArray(inner) || typeof inner === "string") return linesOf(inner)
    }
  }
  return JSON.stringify(value)
}
