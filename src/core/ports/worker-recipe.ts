import type { WorkerRecipe } from "../domain/endpoint.ts"
import type { ModelConfig, Settings } from "../domain/model.ts"

export interface WorkerRecipePort {
  /** Pure: image, env (non-secret), secretEnv and disk size for a model. `weightsGb` null → default sizing. */
  recipe(model: ModelConfig, settings: Settings, weightsGb: number | null): WorkerRecipe
}
