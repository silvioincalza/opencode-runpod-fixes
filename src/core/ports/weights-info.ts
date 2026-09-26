import type { ModelConfig } from "../domain/model.ts"

export interface WeightsInfoPort {
  weightsGb(model: ModelConfig): Promise<number | null>
}
