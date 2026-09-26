import type { ClockPort } from "../../src/core/ports/clock.ts"

/** Drain microtasks (and one macrotask turn). */
export const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

export class FakeClock implements ClockPort {
  private time = 0
  private seq = 0
  private timers: { id: number; at: number; fn: () => void }[] = []

  now(): number {
    return this.time
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.schedule(ms, () => resolve())
    })
  }

  setTimer(fn: () => void, ms: number): unknown {
    return this.schedule(ms, fn)
  }

  clearTimer(id: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== id)
  }

  get pending(): number {
    return this.timers.length
  }

  /** Advance time, firing due timers in order and draining microtasks after each one. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.timers = this.timers.filter((t) => t.id !== due.id)
      this.time = due.at
      due.fn()
      await flush()
    }
    this.time = target
    await flush()
  }

  private schedule(ms: number, fn: () => void): number {
    const id = ++this.seq
    this.timers.push({ id, at: this.time + ms, fn })
    return id
  }
}
