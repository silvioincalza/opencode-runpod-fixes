import type { OperationsPort } from "../../../core/ports/driving.ts"
import { formatModel, formatStatus } from "../rpc/format.ts"
import { OVERRIDE_KEYS, parseOverrides } from "./config.ts"

export interface CommandInvocationLike {
  sessionID: string
  prompt: { text: string }
}

export interface CommandDefinitionLike {
  name: string
  description?: string
  execute(input: CommandInvocationLike): Promise<void>
}

export interface CommandHost {
  command: {
    transform(callback: (editor: { add(definition: CommandDefinitionLike): void }) => void): Promise<unknown>
  }
}

export type Reply = (sessionID: string, text: string) => Promise<void>

/** Whitespace-separated arguments after the slash command token. */
export function parseArgs(text: string): string[] {
  return text.trim().replace(/^\/\S+\s*/, "").split(/\s+/).filter((s) => s.length > 0)
}

const SET_USAGE = `Usage: /runpod-set <model-id> key=value [key=value …] (keys: ${OVERRIDE_KEYS.join(", ")})`

export async function registerCommands(host: CommandHost, ops: OperationsPort, reply: Reply): Promise<void> {
  const guarded = (sessionID: string, action: () => Promise<string>) =>
    action().then(
      (text) => reply(sessionID, text),
      (error: unknown) => reply(sessionID, (error as Error).message),
    )

  await host.command.transform((editor) => {
    editor.add({
      name: "runpod-status",
      description: "RunPod endpoints: phase, GPU, $/h and session spend",
      execute: ({ sessionID }) => guarded(sessionID, async () => formatStatus(await ops.status())),
    })
    editor.add({
      name: "runpod-up",
      description: "Provision and warm a RunPod model without the confirm dialog: /runpod-up <model-id>",
      execute: ({ sessionID, prompt }) =>
        guarded(sessionID, async () => {
          const [modelID] = parseArgs(prompt.text)
          if (!modelID) return "Usage: /runpod-up <model-id>"
          return `RunPod ${modelID} is warm at ${await ops.up(modelID)}`
        }),
    })
    editor.add({
      name: "runpod-down",
      description: "Delete RunPod endpoint(s) and stop billing: /runpod-down [model-id|all]",
      execute: ({ sessionID, prompt }) =>
        guarded(sessionID, async () => {
          const [arg] = parseArgs(prompt.text)
          const deleted = await ops.down(arg && arg !== "all" ? arg : undefined)
          return deleted.length > 0 ? `Deleted RunPod endpoint(s): ${deleted.join(", ")}` : "No RunPod endpoints to delete"
        }),
    })
    editor.add({
      name: "runpod-add",
      description: "Add a model at runtime: /runpod-add <org/repo> [gpu-pool] [key=value …]",
      execute: ({ sessionID, prompt }) =>
        guarded(sessionID, async () => {
          const [hf, ...rest] = parseArgs(prompt.text)
          if (!hf) return "Usage: /runpod-add <org/repo> [gpu-pool] [key=value …]"
          const gpu = rest[0] !== undefined && !rest[0].includes("=") ? rest.shift() : undefined
          const overrides = parseOverrides([...(hf.includes("=") ? [hf] : []), ...rest])
          if (hf.includes("=")) return "Usage: /runpod-add <org/repo> [gpu-pool] [key=value …]"
          if (!/^[\w.-]+\/[\w.-]+$/.test(hf)) return `hf: expected a Hugging Face repo id like org/name, got "${hf}"`
          const added = await ops.add({ hf, ...(gpu === undefined ? {} : { gpu }), overrides })
          return `Added runpod/${added.id} · ${formatModel(added)}\nSelect it in /models; the first request shows the provision dialog.`
        }),
    })
    editor.add({
      name: "runpod-set",
      description: "Change a model's runtime configuration: /runpod-set <model-id> key=value …",
      execute: ({ sessionID, prompt }) =>
        guarded(sessionID, async () => {
          const [modelID, ...pairs] = parseArgs(prompt.text)
          if (!modelID || pairs.length === 0) return SET_USAGE
          const updated = await ops.set(modelID, parseOverrides(pairs))
          return `Updated ${formatModel(updated)}`
        }),
    })
    editor.add({
      name: "runpod-remove",
      description: "Remove a runtime model (and its endpoint) or reset a configured model's overrides: /runpod-remove <model-id>",
      execute: ({ sessionID, prompt }) =>
        guarded(sessionID, async () => {
          const [modelID] = parseArgs(prompt.text)
          if (!modelID) return "Usage: /runpod-remove <model-id>"
          const result = await ops.remove(modelID)
          return result === "removed" ? `Removed runpod/${modelID}` : `Reset runpod/${modelID} to its opencode.json configuration`
        }),
    })
  })
}
