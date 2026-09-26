export interface StateStorePort {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  /** All stored keys starting with `prefix`, sorted. */
  keys(prefix: string): Promise<string[]>
}
