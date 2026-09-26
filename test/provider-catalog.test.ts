import { test } from "node:test"
import assert from "node:assert/strict"
import { PLACEHOLDER_BASE_URL, PROVIDER_ID, buildModelInfo, buildProviderInfo } from "../src/adapters/driving/opencode/provider-catalog.ts"
import { sampleModel } from "./fakes/fixtures.ts"

test("provider info uses the openai-compatible package, placeholder URL and long timeouts", () => {
  const info = buildProviderInfo("rp_key")
  assert.equal(info.id, PROVIDER_ID)
  assert.equal(info.name, "RunPod Serverless")
  assert.equal(info.package, "@opencode/ai/providers/openai-compatible")
  assert.equal(info.activation, "enabled")
  assert.equal(info.settings?.baseURL, PLACEHOLDER_BASE_URL)
  assert.equal(info.settings?.apiKey, "rp_key")
  assert.equal(info.settings?.timeout, 600000)
  assert.equal(info.settings?.chunkTimeout, 600000)
  assert.equal(buildProviderInfo(null).settings?.apiKey, "missing-runpod-api-key")
})

test("model info carries limits, tool capability, the model id as wire id and GPU pools as variants", () => {
  const model = buildModelInfo({ config: sampleModel({ name: "M", context: 40000, output: 4000, tools: false }), variants: ["AMPERE_48", "AMPERE_80"] })
  assert.equal(model.id, "m")
  assert.equal(model.modelID, "m")
  assert.equal(model.providerID, "runpod")
  assert.equal(model.name, "M")
  assert.equal(model.capabilities.tools, false)
  assert.deepEqual(model.capabilities.input, ["text"])
  assert.equal(model.limit.context, 40000)
  assert.equal(model.limit.output, 4000)
  assert.equal(model.status, "active")
  assert.equal(model.enabled, true)
  assert.deepEqual(model.variants.map((v) => v.id), ["AMPERE_48", "AMPERE_80"])
})
