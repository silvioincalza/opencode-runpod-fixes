import type { WorkerRecipe } from "../../src/core/domain/endpoint.ts"
import type { ModelConfig, Settings } from "../../src/core/domain/model.ts"
import type { WorkerRecipePort } from "../../src/core/ports/worker-recipe.ts"

export class FakeRecipe implements WorkerRecipePort {
  recipe(model: ModelConfig, settings: Settings, weightsGb: number | null): WorkerRecipe {
    return {
      image: settings.workerImage,
      env: { MODEL_NAME: model.hf, MAX_MODEL_LEN: String(model.context), ...model.env },
      secretEnv: {},
      diskGb: weightsGb === null ? 20 : Math.ceil(weightsGb) + 10,
    }
  }
}
