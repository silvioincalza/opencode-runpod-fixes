import { test } from "node:test"
import assert from "node:assert/strict"
import { RunpodError, RunpodHttp } from "../src/adapters/driven/runpod/http.ts"

type Handler = Response | ((url: string, init: RequestInit) => Response | Promise<Response>)

function fakeFetch(handlers: Handler[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    const handler = handlers.shift()
    if (!handler) throw new Error(`unexpected fetch ${url}`)
    return typeof handler === "function" ? handler(url, init ?? {}) : handler
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

function client(handlers: Handler[], sleeps: number[] = []) {
  const f = fakeFetch(handlers)
  const c = new RunpodHttp({ apiKey: "rp_key", fetch: f.fetchImpl, sleep: async (ms) => { sleeps.push(ms) } })
  return { c, calls: f.calls }
}

test("createEndpoint posts JSON with bearer auth to REST v2", async () => {
  const { c, calls } = client([json(201, { id: "ep1", name: "oc-runpod-m" })])
  const body = { name: "oc-runpod-m", type: "QUEUE" as const, scaling: { type: "QUEUE_DELAY" as const, queueDelay: 1 }, gpu: { pools: ["AMPERE_48"], count: 1 }, image: "img", env: {}, disk: 20, workers: { min: 0, max: 1, idleTimeout: 120 }, timeout: 600000, flashboot: "FLASHBOOT" as const }
  const ep = await c.createEndpoint(body)
  assert.equal(ep.id, "ep1")
  assert.equal(calls[0]!.url, "https://api.runpod.io/v2/serverless")
  assert.equal(calls[0]!.init.method, "POST")
  const headers = calls[0]!.init.headers as Record<string, string>
  assert.equal(headers.authorization, "Bearer rp_key")
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), body)
})

test("problem+json errors become RunpodError with status, title and detail", async () => {
  const { c } = client([json(400, { title: "Bad Request", status: 400, detail: "gpu.pools is required" })])
  await assert.rejects(c.getEndpoint("x"), (error: unknown) => {
    assert.ok(error instanceof RunpodError)
    assert.equal(error.status, 400)
    assert.equal(error.title, "Bad Request")
    assert.equal(error.detail, "gpu.pools is required")
    assert.match(error.message, /RunPod 400 Bad Request: gpu\.pools is required/)
    return true
  })
})

test("error bodies that echo the API key are redacted", async () => {
  const { c } = client([json(401, { title: "Unauthorized", detail: "invalid key rp_key" })])
  await assert.rejects(c.listEndpoints(), (error: unknown) => {
    assert.ok(error instanceof RunpodError)
    assert.equal(error.detail, "invalid key [redacted]")
    assert.ok(!error.message.includes("rp_key"))
    return true
  })
})

test("429 and 5xx are retried with exponential backoff, then succeed", async () => {
  const sleeps: number[] = []
  const { c, calls } = client([json(429, { title: "Too Many" }), json(502, { title: "Bad Gateway" }), json(200, { id: "ep1", name: "n" })], sleeps)
  const ep = await c.getEndpoint("ep1")
  assert.equal(ep.id, "ep1")
  assert.equal(calls.length, 3)
  assert.deepEqual(sleeps, [1000, 2000])
})

test("gives up after maxRetries", async () => {
  const f = fakeFetch([json(503, {}), json(503, {}), json(503, {}), json(503, {})])
  const c = new RunpodHttp({ apiKey: "k", fetch: f.fetchImpl, sleep: async () => {}, maxRetries: 3 })
  await assert.rejects(c.getEndpoint("ep1"), (e: unknown) => e instanceof RunpodError && e.status === 503)
  assert.equal(f.calls.length, 4)
})

test("listEndpoints follows cursor pagination and unwraps the data array", async () => {
  const { c, calls } = client([
    json(200, { data: [{ id: "a", name: "oc-runpod-a" }], pagination: { nextCursor: "c2", hasNextPage: true } }),
    json(200, { data: [{ id: "b", name: "oc-runpod-b" }], pagination: { hasNextPage: false } }),
  ])
  const list = await c.listEndpoints()
  assert.deepEqual(list.map((e) => e.id), ["a", "b"])
  assert.match(calls[1]!.url, /\?cursor=c2$/)
})

test("listEndpoints accepts a bare array response", async () => {
  const { c } = client([json(200, [{ id: "a", name: "n" }])])
  assert.equal((await c.listEndpoints()).length, 1)
})

test("patchEndpoint sends only the given fields; deleteEndpoint accepts 204", async () => {
  const { c, calls } = client([json(200, { id: "ep1", name: "n" }), new Response(null, { status: 204 })])
  await c.patchEndpoint("ep1", { workers: { min: 0, max: 0 } })
  assert.equal(calls[0]!.init.method, "PATCH")
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { workers: { min: 0, max: 0 } })
  await c.deleteEndpoint("ep1")
  assert.equal(calls[1]!.init.method, "DELETE")
  assert.equal(calls[1]!.url, "https://api.runpod.io/v2/serverless/ep1")
})

test("health hits the runtime host and fills missing counters with zero", async () => {
  const { c, calls } = client([json(200, { workers: { idle: 1 } })])
  const h = await c.health("ep1")
  assert.equal(calls[0]!.url, "https://api.runpod.ai/v2/ep1/health")
  assert.deepEqual(h.workers, { idle: 1, initializing: 0, ready: 0, running: 0, throttled: 0 })
  assert.equal(h.jobs.inQueue, 0)
})

test("chatCompletion posts to the OpenAI route and forwards the abort signal", async () => {
  const { c, calls } = client([json(200, { choices: [] })])
  const controller = new AbortController()
  await c.chatCompletion("ep1", { model: "m", messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }, controller.signal)
  assert.equal(calls[0]!.url, "https://api.runpod.ai/v2/ep1/openai/v1/chat/completions")
  assert.equal(JSON.parse(String(calls[0]!.init.body)).max_tokens, 1)
  assert.equal(calls[0]!.init.signal, controller.signal)
  assert.equal(c.openaiBaseURL("ep1"), "https://api.runpod.ai/v2/ep1/openai/v1")
})

test("an aborted signal is not retried", async () => {
  const { c, calls } = client([() => { throw new Error("aborted") }])
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(c.chatCompletion("ep1", { model: "m" }, controller.signal), /aborted/)
  assert.equal(calls.length, 1)
})

test("billedUsd sums record totals and returns null for unknown shapes", async () => {
  const a = client([json(200, { records: [{ totalAmount: 0.12 }, { totalAmount: 0.3 }] })])
  assert.equal(await a.c.billedUsd("ep1"), 0.42)
  assert.match(a.calls[0]!.url, /\/v2\/billing\/serverless\?endpointId=ep1$/)
  const b = client([json(200, { metadata: { totals: { totalAmount: 1.5 } } })])
  assert.equal(await b.c.billedUsd("ep1"), 1.5)
  const d = client([json(200, { something: "else" })])
  assert.equal(await d.c.billedUsd("ep1"), null)
})

test("workerLogs normalises arrays, objects and plain text to a string", async () => {
  const a = client([json(200, [{ message: "line1" }, "line2"])])
  assert.equal(await a.c.workerLogs("ep1", "w1"), "line1\nline2")
  assert.equal(a.calls[0]!.url, "https://api.runpod.io/v2/serverless/ep1/workers/w1/logs")
  const b = client([new Response("raw text log", { status: 200, headers: { "content-type": "text/plain" } })])
  assert.equal(await b.c.workerLogs("ep1", "w1"), "raw text log")
  const d = client([json(200, { logs: ["x", "y"] })])
  assert.equal(await d.c.workerLogs("ep1", "w1"), "x\ny")
})

test("catalogGpus and listWorkers unwrap items", async () => {
  const { c, calls } = client([
    json(200, { data: [{ id: "NVIDIA A40", pool: "AMPERE_48", price: { serverless: 1.22 } }] }),
    json(200, { workers: [{ id: "w1", status: "UNHEALTHY" }] }),
  ])
  assert.equal((await c.catalogGpus())[0]!.pool, "AMPERE_48")
  assert.match(calls[0]!.url, /\/v2\/catalog\/gpus\?product=SERVERLESS$/)
  assert.equal((await c.listWorkers("ep1"))[0]!.status, "UNHEALTHY")
})
