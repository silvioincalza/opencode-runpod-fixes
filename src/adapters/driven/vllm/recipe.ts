import type { WorkerRecipe } from "../../../core/domain/endpoint.ts"
import type { ModelConfig, Settings } from "../../../core/domain/model.ts"
import { DEFAULT_WEIGHTS_GB } from "../../../core/domain/quote.ts"
import type { WorkerRecipePort } from "../../../core/ports/worker-recipe.ts"
import { inferFamily, parsersFor } from "./presets.ts"

/** Container disk: weights + 15% headroom + 10 GB for image and cache, at least 20 GB. */
export function diskGb(weightsGb: number): number {
  return Math.max(20, Math.ceil(weightsGb * 1.15) + 10)
}

/** Maps a model to the `runpod/worker-v1-vllm` environment (any `vllm serve` flag may be added via `model.env`). */
export class VllmWorkerRecipe implements WorkerRecipePort {
  private readonly hfToken: string | null

  constructor(hfToken: string | null) {
    this.hfToken = hfToken
  }

  recipe(model: ModelConfig, settings: Settings, weightsGb: number | null): WorkerRecipe {
    const family = model.family ?? inferFamily(model.hf)
    const parsers = parsersFor({ family, toolParser: model.toolParser, reasoningParser: model.reasoningParser })
    const toolParser = model.tools ? parsers.toolParser : null
    const env: Record<string, string> = {
      MODEL_NAME: model.hf,
      OPENAI_SERVED_MODEL_NAME_OVERRIDE: model.id,
      MAX_MODEL_LEN: String(model.context),
      ENABLE_AUTO_TOOL_CHOICE: toolParser ? "true" : "false",
    }
    if (toolParser) env.TOOL_CALL_PARSER = toolParser
    if (parsers.reasoningParser) env.REASONING_PARSER = parsers.reasoningParser
    if (model.quantization) env.QUANTIZATION = model.quantization
    const secretEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(model.env)) {
      if (key === "HF_TOKEN") secretEnv.HF_TOKEN = value
      else env[key] = value
    }
    if (this.hfToken) secretEnv.HF_TOKEN = this.hfToken
    return { image: settings.workerImage, env, secretEnv, diskGb: diskGb(weightsGb ?? DEFAULT_WEIGHTS_GB) }
  }
}
