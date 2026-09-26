import type { StateStorePort } from "../../src/core/ports/state-store.ts"

export class InMemoryStateStore implements StateStorePort {
  readonly data = new Map<string, unknown>()
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined
  }
  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value))
  }
  async remove(key: string): Promise<void> {
    this.data.delete(key)
  }
  async keys(prefix: string): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort()
  }
}
