import { test } from "node:test"
import assert from "node:assert/strict"
import { ConfigError, OVERRIDE_KEYS, parseOverrides, resolveSecret, resolveSettings } from "../src/adapters/driving/opencode/config.ts"

const POOLS = ["AMPERE_16", "ADA_24", "AMPERE_48", "AMPERE_80"]
const resolve = (raw: unknown, env: Record<string, string> = {}) => resolveSettings(raw, { env, knownPools: POOLS })

test("defaults are applied; models keep tri-state parsers and a per-model idle timeout", () => {
  const { settings, secrets } = resolve(
    { models: { "qwen3-coder-30b": { hf: "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8", gpu: "AMPERE_48", quantization: "fp8" }, short: { hf: "Qwen/Qwen3-8B", gpu: "ADA_24", idleTimeout: 45 } } },
    { RUNPOD_API_KEY: "rp_test" },
  )
  assert.equal(secrets.apiKey, "rp_test")
  assert.equal(secrets.hfToken, null)
  assert.equal(settings.confirm, true)
  assert.equal(settings.confirmTimeoutSec, 120)
  assert.equal(settings.idleTimeout, 120)
  assert.equal(settings.workersMax, 1)
  assert.equal(settings.executionTimeoutSec, 600)
  assert.equal(settings.coldStartTimeoutSec, 600)
  assert.equal(settings.deleteOnExit, false)
  assert.equal(settings.adoptExisting, true)
  assert.equal(settings.maxHourlyRate, null)
  assert.deepEqual(settings.dataCenterIds, [])
  assert.equal(settings.minCudaVersion, "12.8")
  assert.equal(settings.workerImage, "runpod/worker-v1-vllm:v2.27.2")
  assert.equal(settings.flashboot, true)
  const [m, short] = settings.models
  assert.equal(m!.id, "qwen3-coder-30b")
  assert.equal(m!.name, "qwen3-coder-30b (RunPod)")
  assert.equal(m!.family, null)
  assert.equal(m!.toolParser, undefined)
  assert.equal(m!.reasoningParser, undefined)
  assert.equal(m!.quantization, "fp8")
  assert.equal(m!.context, 32768)
  assert.equal(m!.output, 8192)
  assert.equal(m!.gpuCount, 1)
  assert.equal(m!.tools, true)
  assert.equal(m!.weightsGb, null)
  assert.equal(m!.idleTimeout, null)
  assert.deepEqual(m!.env, {})
  assert.equal(short!.idleTimeout, 45)
  assert.ok(!("apiKey" in settings))
})

test("unknown gpu pool is a ConfigError naming the key and listing known pools", () => {
  assert.throws(
    () => resolve({ models: { x: { hf: "a/b", gpu: "NOPE" } } }),
    (error: unknown) => error instanceof ConfigError && /models\.x\.gpu: unknown pool "NOPE" \(known: AMPERE_16, ADA_24/.test(error.message),
  )
})

test("unknown option keys, bad model ids, bad HF ids and out-of-range idle timeouts are rejected", () => {
  assert.throws(() => resolve({ bogus: 1 }), ConfigError)
  assert.throws(() => resolve({ models: { "Bad Id": { hf: "a/b", gpu: "ADA_24" } } }), /id must match/)
  assert.throws(() => resolve({ models: { ok: { hf: "not-a-repo", gpu: "ADA_24" } } }), /hf/)
  assert.throws(() => resolve({ models: { ok: { hf: "a/b", gpu: "ADA_24", idleTimeout: 0 } } }), /idleTimeout/)
})

test("secret placeholders resolve from env and file; missing values become null", () => {
  assert.equal(resolveSecret("{env:K}", { env: { K: "v" } }), "v")
  assert.equal(resolveSecret("{env:K}", { env: {} }), null)
  assert.equal(resolveSecret("{file:/tmp/k}", { env: {}, readFile: () => "filekey\n" }), "filekey")
  assert.equal(resolveSecret("literal-key", { env: {} }), "literal-key")
  assert.equal(resolveSecret(undefined, { env: {} }), null)
  assert.throws(() => resolveSecret("{file:/nope}", { env: {}, readFile: () => { throw new Error("ENOENT") } }), /cannot read \/nope/)
  assert.equal(resolve({ apiKey: "{env:MISSING}" }).secrets.apiKey, null)
  assert.equal(resolve({ apiKey: "{env:MY_KEY}" }, { MY_KEY: "abc", RUNPOD_API_KEY: "zzz" }).secrets.apiKey, "abc")
  assert.equal(resolve({}, { RUNPOD_API_KEY: "  padded " }).secrets.apiKey, "padded")
  assert.equal(resolve({ hfToken: "hf_lit" }).secrets.hfToken, "hf_lit")
})

test("explicit parser values and family are preserved (null and strings)", () => {
  const { settings } = resolve({ models: { m: { hf: "Qwen/Qwen3-8B", gpu: "ADA_24", toolParser: null, reasoningParser: "qwen3", family: "qwen3", env: { GPU_MEMORY_UTILIZATION: "0.9" } } } })
  const m = settings.models[0]!
  assert.equal(m.toolParser, null)
  assert.equal(m.reasoningParser, "qwen3")
  assert.equal(m.family, "qwen3")
  assert.deepEqual(m.env, { GPU_MEMORY_UTILIZATION: "0.9" })
})

test("parseOverrides coerces key=value pairs into typed overrides", () => {
  assert.deepEqual(parseOverrides(["gpu=AMPERE_80", "context=8192", "tools=false", "toolParser=null", "idleTimeout=60", "weightsGb=12.5", "name=My Model"]), {
    gpu: "AMPERE_80",
    context: 8192,
    tools: false,
    toolParser: null,
    idleTimeout: 60,
    weightsGb: 12.5,
    name: "My Model",
  })
  assert.deepEqual(parseOverrides([]), {})
  assert.deepEqual(OVERRIDE_KEYS, ["name", "hf", "gpu", "gpuCount", "context", "output", "tools", "family", "toolParser", "reasoningParser", "quantization", "weightsGb", "idleTimeout"])
})

test("parseOverrides rejects malformed pairs, unknown keys and bad values with the reason", () => {
  assert.throws(() => parseOverrides(["gpu"]), /expected key=value, got "gpu"/)
  assert.throws(() => parseOverrides(["bogus=1"]), /unknown key "bogus" \(allowed: name, hf, gpu/)
  assert.throws(() => parseOverrides(["context=lots"]), /context: expected a number, got "lots"/)
  assert.throws(() => parseOverrides(["tools=yes"]), /tools: expected true or false/)
  assert.throws(() => parseOverrides(["gpu=null"]), /gpu cannot be null/)
  assert.throws(() => parseOverrides(["context=100"]), /context/)
  assert.throws(() => parseOverrides(["hf=not-a-repo"]), /hf/)
})

test("an explicit apiKey/hfToken that does not resolve never falls back to the environment", () => {
  const env = { RUNPOD_API_KEY: "rp_personal", HF_TOKEN: "hf_personal" }
  const explicit = resolve({ apiKey: "{env:WORK_KEY}", hfToken: "{env:WORK_HF}" }, env).secrets
  assert.equal(explicit.apiKey, null)
  assert.equal(explicit.hfToken, null)
  assert.equal(resolve({ apiKey: "" }, env).secrets.apiKey, null)
  const absent = resolve({}, env).secrets
  assert.equal(absent.apiKey, "rp_personal")
  assert.equal(absent.hfToken, "hf_personal")
})

test("explicit family null is accepted in options; empty parser and quantization values are rejected", () => {
  const { settings } = resolve({ models: { m: { hf: "org/m", gpu: "AMPERE_48", family: null } } })
  assert.equal(settings.models[0]!.family, null)
  assert.throws(() => resolve({ models: { m: { hf: "org/m", gpu: "AMPERE_48", reasoningParser: "" } } }), /models\.m\.reasoningParser/)
  assert.throws(() => parseOverrides(["toolParser="]), /toolParser/)
  assert.throws(() => parseOverrides(["quantization="]), /quantization/)
  assert.deepEqual(parseOverrides(["toolParser=null"]), { toolParser: null }) // explicit null still disables
})
