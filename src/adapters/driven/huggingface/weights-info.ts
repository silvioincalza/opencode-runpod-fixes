import type { ModelConfig } from "../../../core/domain/model.ts"
import type { WeightsInfoPort } from "../../../core/ports/weights-info.ts"

export interface HfSizeResult {
  weightsGb: number
  files: number
  source: "safetensors" | "gguf"
}

interface Sibling {
  rfilename?: string
  size?: number
}

/** Total size of a repo's weight files via the public Hub API (`?blobs=true` includes sizes). Null when unknown. */
export async function fetchWeightsGb(hf: string, opts: { token?: string | null; fetch?: typeof fetch } = {}): Promise<HfSizeResult | null> {
  const fetchImpl = opts.fetch ?? fetch
  const headers: Record<string, string> = { accept: "application/json" }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  let response: Response
  try {
    response = await fetchImpl(`https://huggingface.co/api/models/${hf}?blobs=true`, { headers })
  } catch {
    return null
  }
  if (!response.ok) return null
  let data: { siblings?: Sibling[] }
  try {
    data = (await response.json()) as { siblings?: Sibling[] }
  } catch {
    return null
  }
  const siblings = data.siblings ?? []
  const withExt = (ext: string) => siblings.filter((s) => typeof s.size === "number" && s.rfilename?.endsWith(ext))
  let files = withExt(".safetensors")
  let source: HfSizeResult["source"] = "safetensors"
  if (files.length === 0) {
    files = withExt(".gguf")
    source = "gguf"
  }
  if (files.length === 0) return null
  const bytes = files.reduce((sum, s) => sum + (s.size ?? 0), 0)
  return { weightsGb: Math.round(bytes / 1e8) / 10, files: files.length, source }
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
