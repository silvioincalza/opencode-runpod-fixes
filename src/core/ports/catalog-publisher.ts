import type { ModelConfig } from "../domain/model.ts"

export interface PublishedModel {
  config: ModelConfig
  /** GPU pool ids offered as selectable variants of this model. */
  variants: string[]
}

/** Receives the effective model list whenever it changes (host re-registers the provider). */
export interface CatalogPublisherPort {
  publish(models: readonly PublishedModel[]): Promise<void>
}
