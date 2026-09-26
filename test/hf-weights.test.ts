import { test } from "node:test"
import assert from "node:assert/strict"
import { HfWeightsInfo, fetchWeightsGb } from "../src/adapters/driven/huggingface/weights-info.ts"
import { sampleModel } from "./fakes/fixtures.ts"

function fetchReturning(status: number, body: unknown, seen: { url?: string; headers?: Record<string, string> } = {}) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen.url = String(input)
    seen.headers = (init?.headers ?? {}) as Record<string, string>
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }) as unknown as typeof fetch
}

const GB = 1e9

test("sums safetensors shards and reports GB with one decimal", async () => {
  const seen: { url?: string; headers?: Record<string, string> } = {}
  const result = await fetchWeightsGb("Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8", {
    fetch: fetchReturning(200, { siblings: [{ rfilename: "model-00001-of-00002.safetensors", size: 20 * GB }, { rfilename: "model-00002-of-00002.safetensors", size: 11.55 * GB }, { rfilename: "README.md", size: 1000 }] }, seen),
  })
  assert.deepEqual(result, { weightsGb: 31.6, files: 2, source: "safetensors" })
  assert.equal(seen.url, "https://huggingface.co/api/models/Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8?blobs=true")
  assert.equal(seen.headers?.authorization, undefined)
})

test("falls back to gguf files and sends the token when given", async () => {
  const seen: { url?: string; headers?: Record<string, string> } = {}
  const result = await fetchWeightsGb("org/repo", { token: "hf_x", fetch: fetchReturning(200, { siblings: [{ rfilename: "model-Q4_K_M.gguf", size: 18 * GB }] }, seen) })
  assert.deepEqual(result, { weightsGb: 18, files: 1, source: "gguf" })
  assert.equal(seen.headers?.authorization, "Bearer hf_x")
})

test("returns null on HTTP errors, network errors and repos without weights", async () => {
  assert.equal(await fetchWeightsGb("org/missing", { fetch: fetchReturning(404, { error: "not found" }) }), null)
  assert.equal(await fetchWeightsGb("org/empty", { fetch: fetchReturning(200, { siblings: [{ rfilename: "README.md", size: 10 }] }) }), null)
  const failing = (async () => { throw new Error("offline") }) as unknown as typeof fetch
  assert.equal(await fetchWeightsGb("org/repo", { fetch: failing }), null)
})

test("HfWeightsInfo implements the port for a model", async () => {
  const port = new HfWeightsInfo({ token: null, fetch: fetchReturning(200, { siblings: [{ rfilename: "a.safetensors", size: 5 * GB }] }) })
  assert.equal(await port.weightsGb(sampleModel()), 5)
  const empty = new HfWeightsInfo({ token: null, fetch: fetchReturning(500, {}) })
  assert.equal(await empty.weightsGb(sampleModel()), null)
})
