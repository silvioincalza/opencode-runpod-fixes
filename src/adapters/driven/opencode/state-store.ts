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
    const out = new Set<string>()
    const seen = new Set<string>()
    let after: string | undefined
    do {
      const page = await this.storage.scan({ prefix, after, limit: PAGE_SIZE })
      for (const entry of page.entries) out.add(entry.key)
      // Startup lists keys through here: a cursor that stops advancing must end the scan, not hang the host.
      const next = page.next
      after = next !== undefined && next !== "" && !seen.has(next) ? next : undefined
      if (after !== undefined) seen.add(after)
    } while (after !== undefined)
    return [...out].sort()
  }
}
