import type { WorkerRecipe } from "../domain/endpoint.ts"
import type { ModelConfig, Settings } from "../domain/model.ts"

export interface WorkerRecipePort {
  /**
   * Pure: image, env (non-secret), secretEnv and disk size for a model. `weightsGb` null → default sizing.
   * `weightsGb` may only size the disk: image and env must not depend on it, because the startup reconcile recomputes the spec hash with `weightsGb = null`.
   */
  recipe(model: ModelConfig, settings: Settings, weightsGb: number | null): WorkerRecipe
}
