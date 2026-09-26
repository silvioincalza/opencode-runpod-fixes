import type { Model, Provider } from "@opencode/plugin"
import type { PublishedModel } from "../../../core/ports/catalog-publisher.ts"

export const PROVIDER_ID = "runpod"
export const PROVIDER_NAME = "RunPod Serverless"
export const PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible"
/** Replaced per request by the model.request hook once an endpoint is warm. */
export const PLACEHOLDER_BASE_URL = "https://api.runpod.ai/v2/pending/openai/v1"
const REQUEST_TIMEOUT_MS = 600_000

export function buildProviderInfo(apiKey: string | null): Provider.Info {
  return {
    id: PROVIDER_ID as Provider.ID,
    name: PROVIDER_NAME,
    package: PROVIDER_PACKAGE,
    activation: "enabled",
    settings: {
      baseURL: PLACEHOLDER_BASE_URL,
      apiKey: apiKey ?? "missing-runpod-api-key",
      provider: PROVIDER_ID,
      timeout: REQUEST_TIMEOUT_MS,
      chunkTimeout: REQUEST_TIMEOUT_MS,
    },
  }
}

/** GPU pools appear as selectable variants; the model.request hook receives the chosen pool as `model.variant`. */
export function buildModelInfo(published: PublishedModel): Model.Info {
  const model = published.config
  return {
    id: model.id as Model.ID,
    providerID: PROVIDER_ID as Provider.ID,
    modelID: model.id as Model.ID,
    name: model.name,
    capabilities: { tools: model.tools, input: ["text"], output: ["text"] },
    variants: published.variants.map((pool) => ({ id: pool as Model.VariantID })),
    time: { released: Date.UTC(2026, 0, 1) },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: model.context, output: model.output },
  }
}
