export interface ClockPort {
  now(): number
  sleep(ms: number): Promise<void>
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(id: unknown): void
}
