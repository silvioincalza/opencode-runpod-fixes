import type { StateStorePort } from "../../../core/ports/state-store.ts"

/** The subset of `ctx.storage` this adapter needs. */
export interface OpencodeStorageLike {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  scan(options: { prefix: string; after?: string; limit?: number }): Promise<{ entries: readonly { key: string; value: unknown }[]; next?: string }>
}

const PAGE_SIZE = 100

/** Adapts `ctx.storage` (durable, plugin-scoped JSON) to the StateStorePort. */
export class OpencodeStateStore implements StateStorePort {
  private readonly storage: OpencodeStorageLike

  constructor(storage: OpencodeStorageLike) {
    this.storage = storage
  }

  async get<T>(key: string): Promise<T | undefined> {
    return (await this.storage.get(key)) as T | undefined
  }

  set(key: string, value: unknown): Promise<void> {
    return this.storage.set(key, value)
  }

  remove(key: string): Promise<void> {
    return this.storage.remove(key)
  }

  async keys(prefix: string): Promise<string[]> {
    const out: string[] = []
    let after: string | undefined
    do {
      const page = await this.storage.scan({ prefix, after, limit: PAGE_SIZE })
      out.push(...page.entries.map((e) => e.key))
      after = page.next
    } while (after)
    return out.sort()
  }
}
