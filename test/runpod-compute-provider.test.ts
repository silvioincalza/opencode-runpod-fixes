import { test } from "node:test"
import assert from "node:assert/strict"
import { HASH_ENV, MARKER_ENV, RunpodComputeProvider, toCreateBody } from "../src/adapters/driven/runpod/compute-provider.ts"
import { RunpodError, type RunpodHttpLike } from "../src/adapters/driven/runpod/http.ts"
import type { EndpointInfo, WorkerInfo } from "../src/adapters/driven/runpod/types.ts"
import type { EndpointSpec } from "../src/core/domain/endpoint.ts"
import { ComputeError } from "../src/core/ports/compute-provider.ts"

const spec: EndpointSpec = {
  name: "oc-runpod-m",
  modelID: "m",
  recipe: { image: "runpod/worker-v1-vllm:v2.27.2", env: { MODEL_NAME: "Qwen/Qwen3-8B", OPENCODE_RUNPOD_HASH: "user-supplied-junk" }, secretEnv: { HF_TOKEN: "hf_x" }, diskGb: 42 },
  gpu: { pool: "AMPERE_48", count: 2, minCudaVersion: "12.8" },
  workers: { min: 0, max: 1, idleTimeoutSec: 120 },
  executionTimeoutSec: 600,
  flashboot: true,
  dataCenterIds: ["EU-RO-1"],
  hash: "abcdef0123456789",
}

class FakeHttp implements RunpodHttpLike {
  calls: string[] = []
  endpoints: EndpointInfo[] = []
  workers: WorkerInfo[] = []
  logs = ""
  chatError: Error | null = null
  deleteError: Error | null = null
  lastChat: { body: unknown; signal: AbortSignal } | null = null
  openaiBaseURL(id: string) { return `https://api.runpod.ai/v2/${id}/openai/v1` }
  async listEndpoints() { this.calls.push("list"); return this.endpoints }
  async createEndpoint(body: Parameters<RunpodHttpLike["createEndpoint"]>[0]) { this.calls.push(`create:${JSON.stringify(body)}`); return { id: "ep9", name: body.name } }
  async getEndpoint(id: string) { return { id, name: "n" } }
  async patchEndpoint(id: string, patch: Parameters<RunpodHttpLike["patchEndpoint"]>[1]) { this.calls.push(`patch:${id}:${JSON.stringify(patch)}`); return { id, name: "n" } }
  async deleteEndpoint(id: string) { this.calls.push(`delete:${id}`); if (this.deleteError) throw this.deleteError }
  async listWorkers() { return this.workers }
  async workerLogs(_id: string, workerId: string) { this.calls.push(`logs:${workerId}`); return this.logs }
  async catalogGpus() { return [] }
  async billedUsd() { return 0.5 }
  async health() { return { jobs: { completed: 0, failed: 0, inProgress: 0, inQueue: 0, retried: 0 }, workers: { idle: 1, initializing: 2, ready: 0, running: 3, throttled: 4 } } }
  async chatCompletion(id: string, body: unknown, signal: AbortSignal) { this.calls.push(`chat:${id}`); this.lastChat = { body, signal }; if (this.chatError) throw this.chatError; return {} }
}

test("toCreateBody maps the spec and appends markers after user env and secrets", () => {
  const body = toCreateBody(spec)
  assert.equal(body.name, "oc-runpod-m")
  assert.equal(body.type, "QUEUE")
  assert.deepEqual(body.scaling, { type: "QUEUE_DELAY", queueDelay: 1 })
  assert.deepEqual(body.gpu, { pools: ["AMPERE_48"], count: 2, minCudaVersion: "12.8" })
  assert.equal(body.image, "runpod/worker-v1-vllm:v2.27.2")
  assert.equal(body.disk, 42)
  assert.deepEqual(body.workers, { min: 0, max: 1, idleTimeout: 120 })
  assert.equal(body.timeout, 600000)
  assert.equal(body.flashboot, "FLASHBOOT")
  assert.deepEqual(body.dataCenterIds, ["EU-RO-1"])
  assert.equal(body.env.MODEL_NAME, "Qwen/Qwen3-8B")
  assert.equal(body.env.HF_TOKEN, "hf_x")
  assert.equal(body.env[MARKER_ENV], "1")
  assert.equal(body.env[HASH_ENV], "abcdef0123456789")
  const noDc = toCreateBody({ ...spec, dataCenterIds: [], flashboot: false })
  assert.equal(noDc.dataCenterIds, undefined)
  assert.equal(noDc.flashboot, "OFF")
})

test("list exposes ids, names and the hash marker; create returns the id", async () => {
  const http = new FakeHttp()
  http.endpoints = [{ id: "a", name: "oc-runpod-a", env: { [HASH_ENV]: "h1" } }, { id: "b", name: "other" }]
  const provider = new RunpodComputeProvider(http)
  assert.deepEqual(await provider.list(), [{ id: "a", name: "oc-runpod-a", hash: "h1" }, { id: "b", name: "other", hash: null }])
  assert.deepEqual(await provider.create(spec), { id: "ep9" })
  assert.equal(provider.inferenceBaseURL("ep9"), "https://api.runpod.ai/v2/ep9/openai/v1")
})

test("scaleToZero and setIdleTimeout patch workers; delete tolerates 404 only", async () => {
  const http = new FakeHttp()
  const provider = new RunpodComputeProvider(http)
  await provider.scaleToZero("ep1")
  assert.equal(http.calls.at(-1), 'patch:ep1:{"workers":{"min":0,"max":0}}')
  await provider.setIdleTimeout("ep1", 30)
  assert.equal(http.calls.at(-1), 'patch:ep1:{"workers":{"idleTimeout":30}}')
  http.deleteError = new RunpodError(404, "Not Found", null, "DELETE")
  await provider.delete("ep1")
  http.deleteError = new RunpodError(403, "Forbidden", null, "DELETE")
  await assert.rejects(provider.delete("ep1"), /403/)
})

test("health maps worker counters; billedUsd passes through", async () => {
  const provider = new RunpodComputeProvider(new FakeHttp())
  assert.deepEqual(await provider.health("ep1"), { initializing: 2, running: 3, idle: 1, throttled: 4 })
  assert.equal(await provider.billedUsd("ep1"), 0.5)
})

test("warmup sends a one-token completion and maps HTTP errors to ComputeError kinds", async () => {
  const http = new FakeHttp()
  const provider = new RunpodComputeProvider(http)
  await provider.warmup("ep1", "m", new AbortController().signal)
  assert.equal(http.calls.at(-1), "chat:ep1")
  http.chatError = new RunpodError(400, "Bad Request", "model not found", "POST")
  await assert.rejects(provider.warmup("ep1", "m", new AbortController().signal), (e: unknown) => e instanceof ComputeError && e.kind === "fatal" && e.status === 400)
  http.chatError = new RunpodError(502, "Bad Gateway", null, "POST")
  await assert.rejects(provider.warmup("ep1", "m", new AbortController().signal), (e: unknown) => e instanceof ComputeError && e.kind === "transient" && e.status === 502)
  http.chatError = new RunpodError(429, "Too Many", null, "POST")
  await assert.rejects(provider.warmup("ep1", "m", new AbortController().signal), (e: unknown) => e instanceof ComputeError && e.kind === "transient")
  http.chatError = new Error("socket hang up")
  await assert.rejects(provider.warmup("ep1", "m", new AbortController().signal), (e: unknown) => e instanceof ComputeError && e.kind === "transient" && e.status === null)
})

test("diagnostics returns the last 40 log lines of an unhealthy worker, or null", async () => {
  const http = new FakeHttp()
  const provider = new RunpodComputeProvider(http)
  assert.equal(await provider.diagnostics("ep1"), null)
  http.workers = [{ id: "w1", status: "RUNNING" }, { id: "w2", status: "UNHEALTHY" }]
  http.logs = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n")
  const tail = await provider.diagnostics("ep1")
  assert.equal(http.calls.at(-1), "logs:w2")
  assert.equal(tail?.split("\n").length, 40)
  assert.ok(tail?.startsWith("line 11"))
  assert.ok(tail?.endsWith("line 50"))
})

test("warmup posts a one-token ping for the served model name, forwards the abort signal, and treats 408 as transient", async () => {
  const http = new FakeHttp()
  const provider = new RunpodComputeProvider(http)
  const controller = new AbortController()
  await provider.warmup("ep1", "m", controller.signal)
  assert.deepEqual(http.lastChat?.body, { model: "m", messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false })
  assert.equal(http.lastChat?.signal, controller.signal)
  http.chatError = new RunpodError(408, "Request Timeout", null, "POST")
  await assert.rejects(provider.warmup("ep1", "m", controller.signal), (e: unknown) => e instanceof ComputeError && e.kind === "transient" && e.status === 408)
})

test("create sends exactly toCreateBody(spec); an empty minCudaVersion is omitted", async () => {
  const http = new FakeHttp()
  await new RunpodComputeProvider(http).create(spec)
  assert.deepEqual(http.calls, [`create:${JSON.stringify(toCreateBody(spec))}`])
  const body = toCreateBody({ ...spec, gpu: { ...spec.gpu, minCudaVersion: "" } })
  assert.equal("minCudaVersion" in body.gpu, false)
})

test("diagnostics is best effort: log failures and empty logs yield null; CRLF logs are normalised", async () => {
  const http = new FakeHttp()
  const provider = new RunpodComputeProvider(http)
  http.workers = [{ id: "w2", status: "UNHEALTHY" }]
  http.logs = "  \n "
  assert.equal(await provider.diagnostics("ep1"), null)
  http.logs = "a\r\nb\r\n"
  assert.equal(await provider.diagnostics("ep1"), "a\nb")
  http.workerLogs = async () => {
    throw new Error("gone")
  }
  assert.equal(await provider.diagnostics("ep1"), null)
})
