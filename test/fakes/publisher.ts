import type { CatalogPublisherPort, PublishedModel } from "../../src/core/ports/catalog-publisher.ts"

export class FakePublisher implements CatalogPublisherPort {
  published: PublishedModel[][] = []
  async publish(models: readonly PublishedModel[]): Promise<void> {
    this.published.push(models.map((m) => ({ config: structuredClone(m.config), variants: [...m.variants] })))
  }
  get latest(): PublishedModel[] | undefined {
    return this.published.at(-1)
  }
}
