import type { ClockPort } from "../../../core/ports/clock.ts"

/** Service timers are advisory (idle, polls, retries, deadlines): never let one hold the host process open. */
function unref<T>(timer: T): T {
  const handle = timer as { unref?: () => void }
  handle.unref?.()
  return timer
}

export class SystemClock implements ClockPort {
  now(): number {
    return Date.now()
  }
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      unref(setTimeout(resolve, ms))
    })
  }
  setTimer(fn: () => void, ms: number): unknown {
    return unref(setTimeout(fn, ms))
  }
  clearTimer(id: unknown): void {
    clearTimeout(id as ReturnType<typeof setTimeout>)
  }
}
