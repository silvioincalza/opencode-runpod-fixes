import type { ModelConfig } from "../../../core/domain/model.ts"
import type { WeightsInfoPort } from "../../../core/ports/weights-info.ts"

export interface HfSizeResult {
  weightsGb: number
  files: number
  source: "safetensors" | "gguf"
}

/** Metadata lookups are small; a hung Hub request must not stall the provisioning dialog. */
export const HF_TIMEOUT_MS = 10_000

interface Sibling {
  rfilename: string
  size: number
}

const isSibling = (value: unknown): value is Sibling =>
  typeof value === "object" && value !== null && typeof (value as Sibling).rfilename === "string" && typeof (value as Sibling).size === "number"

const SHARD = /^(.*)-\d{5}-of-\d{5}\.(?:safetensors|gguf)$/

/** Root-level shard sets keyed by their prefix (`model-00001-of-00003.safetensors` → `model`). */
function shardGroups(files: Sibling[]): Map<string, Sibling[]> {
  const groups = new Map<string, Sibling[]>()
  for (const file of files) {
    const match = SHARD.exec(file.rfilename)
    if (match) groups.set(match[1]!, [...(groups.get(match[1]!) ?? []), file])
  }
  return groups
}

/** The safetensors a loader reads: the `model-*` shard set (or the only shard set), else `model.safetensors`, else the only file; null when ambiguous. */
function pickSafetensors(root: Sibling[]): Sibling[] | null {
  const groups = shardGroups(root)
  const sharded = groups.get("model") ?? (groups.size === 1 ? [...groups.values()][0]! : undefined)
  if (sharded) return sharded
  if (groups.size > 1) return null
  const single = root.find((f) => f.rfilename === "model.safetensors")
  if (single) return [single]
  return root.length === 1 ? root : null
}

/** GGUF repos usually hold several quantizations and only one is ever loaded: size only a single file or a single shard set. */
function pickGguf(root: Sibling[]): Sibling[] | null {
  if (root.length === 1) return root
  const groups = shardGroups(root)
  const only = groups.size === 1 ? [...groups.values()][0]! : undefined
  return only && only.length === root.length ? only : null
}

/** Size of the weight files a loader would read, via the public Hub API (`?blobs=true` includes sizes). Null when unknown or ambiguous. */
export async function fetchWeightsGb(
  hf: string,
  opts: { token?: string | null; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<HfSizeResult | null> {
  const fetchImpl = opts.fetch ?? fetch
  const headers: Record<string, string> = { accept: "application/json" }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  const path = hf.split("/").map(encodeURIComponent).join("/")
  let data: unknown
  try {
    const response = await fetchImpl(`https://huggingface.co/api/models/${path}?blobs=true`, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? HF_TIMEOUT_MS) })
    if (!response.ok) return null
    data = await response.json()
  } catch {
    return null
  }
  const listed = (data as { siblings?: unknown } | null)?.siblings
  const siblings = Array.isArray(listed) ? listed.filter(isSibling) : []
  // Subfolders hold duplicates (original/, onnx/, alternative quantizations): only root-level files are loaded.
  const root = (ext: string) => siblings.filter((s) => !s.rfilename.includes("/") && s.rfilename.endsWith(ext))
  const safetensors = root(".safetensors")
  const source: HfSizeResult["source"] = safetensors.length > 0 ? "safetensors" : "gguf"
  const files = safetensors.length > 0 ? pickSafetensors(safetensors) : root(".gguf").length > 0 ? pickGguf(root(".gguf")) : null
  if (!files || files.length === 0) return null
  const bytes = files.reduce((sum, s) => sum + s.size, 0)
  if (bytes <= 0) return null
  return { weightsGb: Math.max(0.1, Math.round(bytes / 1e8) / 10), files: files.length, source }
}

export class HfWeightsInfo implements WeightsInfoPort {
  private readonly token: string | null
  private readonly fetchImpl: typeof fetch | undefined

  constructor(opts: { token: string | null; fetch?: typeof fetch }) {
    this.token = opts.token
    this.fetchImpl = opts.fetch
  }

  async weightsGb(model: ModelConfig): Promise<number | null> {
    const result = await fetchWeightsGb(model.hf, { token: this.token, fetch: this.fetchImpl })
    return result?.weightsGb ?? null
  }
}
