import { test } from "node:test"
import assert from "node:assert/strict"
import { parseArgs, registerCommands, type CommandHost } from "../src/adapters/driving/opencode/commands.ts"
import type { StatusReport } from "../src/core/domain/events.ts"
import type { ModelConfig } from "../src/core/domain/model.ts"
import type { OperationsPort } from "../src/core/ports/driving.ts"
import { sampleModel } from "./fakes/fixtures.ts"

type Definition = { name: string; description?: string; execute(input: { sessionID: string; prompt: { text: string } }): Promise<void> }

function host() {
  const defs = new Map<string, Definition>()
  const h: CommandHost = { command: { transform: async (cb) => { cb({ add: (def) => defs.set(def.name, def) }) } } }
  return { h, defs }
}

const report: StatusReport = { models: [{ modelID: "m", phase: "ready", detail: null, spendUsd: 0.1, ratePerHour: 1.22, gpu: "AMPERE_48", gpuLabel: "A6000/A40 48GB", endpointID: "ep1", gpuCount: 1, billedUsd: null, lastRequestAt: 0, workers: null }], orphans: [] }

function ops(overrides: Partial<OperationsPort> = {}): OperationsPort & { calls: string[] } {
  const calls: string[] = []
  const added: ModelConfig = sampleModel({ id: "qwen3-8b", hf: "Qwen/Qwen3-8B", quantization: null })
  return {
    calls,
    status: async () => { calls.push("status"); return report },
    up: async (modelID) => { calls.push(`up:${modelID}`); return `https://x/${modelID}/v1` },
    down: async (modelID) => { calls.push(`down:${modelID ?? "*"}`); return modelID ? [modelID] : ["m", "n"] },
    add: async (input) => { calls.push(`add:${JSON.stringify(input)}`); return { ...added, gpu: input.gpu ?? "AMPERE_48", ...(input.overrides ?? {}) } },
    set: async (modelID, o) => { calls.push(`set:${modelID}:${JSON.stringify(o)}`); return sampleModel({ ...o, id: modelID }) },
    remove: async (modelID) => { calls.push(`remove:${modelID}`); return modelID === "m" ? "reset" : "removed" },
    models: () => [sampleModel()],
    ...overrides,
  }
}

async function run(defs: Map<string, Definition>, name: string, text: string) {
  await defs.get(name)!.execute({ sessionID: "s", prompt: { text } })
}

test("parseArgs strips the command token and splits on whitespace", () => {
  assert.deepEqual(parseArgs("/runpod-add Qwen/Qwen3-8B  AMPERE_48 context=8192"), ["Qwen/Qwen3-8B", "AMPERE_48", "context=8192"])
  assert.deepEqual(parseArgs("my-model"), ["my-model"])
  assert.deepEqual(parseArgs("/runpod-up"), [])
  assert.deepEqual(parseArgs("   "), [])
})

test("status/up/down commands reply through the reply channel", async () => {
  const { h, defs } = host()
  const o = ops()
  const replies: string[] = []
  await registerCommands(h, o, async (_sessionID, text) => { replies.push(text) })
  assert.deepEqual([...defs.keys()].sort(), ["runpod-add", "runpod-down", "runpod-remove", "runpod-set", "runpod-status", "runpod-up"])
  await run(defs, "runpod-status", "")
  assert.match(replies.at(-1)!, /^m: ready \[ep1\]/)
  await run(defs, "runpod-up", "/runpod-up m")
  assert.equal(replies.at(-1), "RunPod m is warm at https://x/m/v1")
  await run(defs, "runpod-up", "")
  assert.equal(replies.at(-1), "Usage: /runpod-up <model-id>")
  await run(defs, "runpod-down", "m")
  assert.equal(replies.at(-1), "Deleted RunPod endpoint(s): m")
  await run(defs, "runpod-down", "all")
  assert.equal(replies.at(-1), "Deleted RunPod endpoint(s): m, n")
  assert.deepEqual(o.calls, ["status", "up:m", "down:m", "down:*"])
})

test("add/set/remove commands parse their arguments and describe the effective config", async () => {
  const { h, defs } = host()
  const o = ops()
  const replies: string[] = []
  await registerCommands(h, o, async (_s, text) => { replies.push(text) })
  await run(defs, "runpod-add", "/runpod-add Qwen/Qwen3-8B AMPERE_80 context=8192 idleTimeout=60")
  assert.equal(o.calls.at(-1), 'add:{"hf":"Qwen/Qwen3-8B","gpu":"AMPERE_80","overrides":{"context":8192,"idleTimeout":60}}')
  assert.match(replies.at(-1)!, /^Added runpod\/qwen3-8b · qwen3-8b: hf=Qwen\/Qwen3-8B gpu=AMPERE_80 .*context=8192 .*idleTimeout=60\nSelect it in \/models; the first request shows the provision dialog\.$/)
  await run(defs, "runpod-add", "/runpod-add Qwen/Qwen3-8B context=4096")
  assert.equal(o.calls.at(-1), 'add:{"hf":"Qwen/Qwen3-8B","gpu":undefined,"overrides":{"context":4096}}'.replace('"gpu":undefined,', ""))
  await run(defs, "runpod-add", "")
  assert.equal(replies.at(-1), "Usage: /runpod-add <org/repo> [gpu-pool] [key=value …]")
  await run(defs, "runpod-add", "not-a-repo")
  assert.match(replies.at(-1)!, /hf/)
  await run(defs, "runpod-set", "m gpu=AMPERE_80 idleTimeout=null")
  assert.equal(o.calls.at(-1), 'set:m:{"gpu":"AMPERE_80","idleTimeout":null}')
  assert.match(replies.at(-1)!, /^Updated m: hf=.* gpu=AMPERE_80/)
  await run(defs, "runpod-set", "m")
  assert.equal(replies.at(-1), "Usage: /runpod-set <model-id> key=value [key=value …] (keys: name, hf, gpu, gpuCount, context, output, tools, family, toolParser, reasoningParser, quantization, weightsGb, idleTimeout)")
  await run(defs, "runpod-set", "m bogus=1")
  assert.match(replies.at(-1)!, /unknown key "bogus"/)
  await run(defs, "runpod-remove", "m")
  assert.equal(replies.at(-1), "Reset runpod/m to its opencode.json configuration")
  await run(defs, "runpod-remove", "qwen3-8b")
  assert.equal(replies.at(-1), "Removed runpod/qwen3-8b")
  await run(defs, "runpod-remove", "")
  assert.equal(replies.at(-1), "Usage: /runpod-remove <model-id>")
})

test("errors from the operations port are reported as text, never thrown", async () => {
  const { h, defs } = host()
  const replies: string[] = []
  await registerCommands(h, ops({ up: async () => { throw new Error("RunPod: declined") }, down: async () => [], add: async () => { throw new Error("RunPod: already exists") } }), async (_s, text) => { replies.push(text) })
  await run(defs, "runpod-up", "m")
  assert.equal(replies.at(-1), "RunPod: declined")
  await run(defs, "runpod-down", "")
  assert.equal(replies.at(-1), "No RunPod endpoints to delete")
  await run(defs, "runpod-add", "org/repo")
  assert.equal(replies.at(-1), "RunPod: already exists")
})
