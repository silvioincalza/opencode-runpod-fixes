import type { CatalogPublisherPort, PublishedModel } from "../../../core/ports/catalog-publisher.ts"

/**
 * Holds the effective model list for the provider transform (which the composition root registers)
 * and asks opencode to re-run its provider transforms whenever the list changes.
 */
export class OpencodeCatalogPublisher implements CatalogPublisherPort {
  private models: PublishedModel[] = []
  private readonly reload: () => Promise<void>

  constructor(reload: () => Promise<void>) {
    this.reload = reload
  }

  get current(): readonly PublishedModel[] {
    return this.models
  }

  /** Sets the list without a reload; used once before the provider transform is registered. */
  seed(models: readonly PublishedModel[]): void {
    this.models = copy(models)
  }

  async publish(models: readonly PublishedModel[]): Promise<void> {
    this.models = copy(models)
    await this.reload()
  }
}

function copy(models: readonly PublishedModel[]): PublishedModel[] {
  return models.map((m) => ({ config: { ...m.config, env: { ...m.config.env } }, variants: [...m.variants] }))
}
