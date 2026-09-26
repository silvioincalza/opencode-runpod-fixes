import { test } from "node:test"
import assert from "node:assert/strict"
import { FAMILIES, inferFamily, parsersFor } from "../src/adapters/driven/vllm/presets.ts"
import { VllmWorkerRecipe, diskGb } from "../src/adapters/driven/vllm/recipe.ts"
import { sampleModel, sampleSettings } from "./fakes/fixtures.ts"

test("inferFamily recognises common repos", () => {
  assert.equal(inferFamily("Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8"), "qwen3-coder")
  assert.equal(inferFamily("huihui-ai/Huihui-Qwen3.8-27B-abliterated"), "qwen3")
  assert.equal(inferFamily("zai-org/GLM-4.7-Flash"), "glm-4.7")
  assert.equal(inferFamily("openai/gpt-oss-20b"), "gpt-oss")
  assert.equal(inferFamily("mistralai/Devstral-Small-2-24B"), "devstral")
  assert.equal(inferFamily("Kwaipilot/KAT-Coder-V2.5"), null)
})

test("parsersFor: explicit values win, null disables, undefined falls back to the preset", () => {
  assert.deepEqual(parsersFor({ family: "qwen3" }), FAMILIES.qwen3)
  assert.deepEqual(parsersFor({ family: "qwen3", toolParser: "qwen3_xml" }), { toolParser: "qwen3_xml", reasoningParser: "qwen3" })
  assert.deepEqual(parsersFor({ family: "qwen3", reasoningParser: null }), { toolParser: "hermes", reasoningParser: null })
  assert.deepEqual(parsersFor({ family: null }), { toolParser: null, reasoningParser: null })
})

test("recipe maps model config to vLLM worker env, infers the family and sizes the disk", () => {
  const settings = sampleSettings()
  const model = sampleModel({ env: { GPU_MEMORY_UTILIZATION: "0.92" } })
  const recipe = new VllmWorkerRecipe(null).recipe(model, settings, 31.6)
  assert.equal(recipe.image, "runpod/worker-v1-vllm:v2.27.2")
  assert.deepEqual(recipe.env, {
    MODEL_NAME: "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8",
    OPENAI_SERVED_MODEL_NAME_OVERRIDE: "m",
    MAX_MODEL_LEN: "65536",
    ENABLE_AUTO_TOOL_CHOICE: "true",
    TOOL_CALL_PARSER: "qwen3_xml",
    QUANTIZATION: "fp8",
    GPU_MEMORY_UTILIZATION: "0.92",
  })
  assert.deepEqual(recipe.secretEnv, {})
  assert.equal(recipe.diskGb, diskGb(31.6))
})

test("explicit family, reasoning parser, disabled tools and HF token", () => {
  const settings = sampleSettings()
  const withReasoning = new VllmWorkerRecipe("hf_secret").recipe(sampleModel({ hf: "Qwen/Qwen3-8B", quantization: null }), settings, null)
  assert.equal(withReasoning.env.TOOL_CALL_PARSER, "hermes")
  assert.equal(withReasoning.env.REASONING_PARSER, "qwen3")
  assert.equal(withReasoning.env.QUANTIZATION, undefined)
  assert.deepEqual(withReasoning.secretEnv, { HF_TOKEN: "hf_secret" })
  assert.equal(withReasoning.diskGb, diskGb(60))
  const explicit = new VllmWorkerRecipe(null).recipe(sampleModel({ hf: "Kwaipilot/KAT-Coder-V2.5", family: "qwen3-coder" }), settings, 10)
  assert.equal(explicit.env.TOOL_CALL_PARSER, "qwen3_xml")
  const noTools = new VllmWorkerRecipe(null).recipe(sampleModel({ tools: false }), settings, 10)
  assert.equal(noTools.env.ENABLE_AUTO_TOOL_CHOICE, "false")
  assert.equal(noTools.env.TOOL_CALL_PARSER, undefined)
  const disabledParser = new VllmWorkerRecipe(null).recipe(sampleModel({ toolParser: null }), settings, 10)
  assert.equal(disabledParser.env.ENABLE_AUTO_TOOL_CHOICE, "false")
})

test("HF_TOKEN in user env is moved to secretEnv so it is never hashed", () => {
  const recipe = new VllmWorkerRecipe(null).recipe(sampleModel({ env: { HF_TOKEN: "leaked" } }), sampleSettings(), 10)
  assert.equal(recipe.env.HF_TOKEN, undefined)
  assert.equal(recipe.secretEnv.HF_TOKEN, "leaked")
})

test("disk grows with weights with a floor of 20 GB", () => {
  assert.equal(diskGb(1), 20)
  assert.equal(diskGb(30), Math.ceil(30 * 1.15) + 10)
})

test("weights only size the disk: image and env do not depend on weightsGb (the startup reconcile hashes with null)", () => {
  const recipe = new VllmWorkerRecipe("hf_secret")
  const model = sampleModel()
  const settings = sampleSettings()
  const small = recipe.recipe(model, settings, 10)
  const large = recipe.recipe(model, settings, 80)
  const unknown = recipe.recipe(model, settings, null)
  assert.deepEqual(large.env, small.env)
  assert.deepEqual(unknown.env, small.env)
  assert.equal(large.image, small.image)
  assert.equal(unknown.image, small.image)
  assert.ok(large.diskGb > small.diskGb)
})
