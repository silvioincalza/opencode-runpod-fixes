/** Accumulates $ while a worker is believed to be running. */
export class SpendMeter {
  private accumulated = 0
  private rate = 0
  private since: number | null = null
  private readonly now: () => number

  constructor(now: () => number) {
    this.now = now
  }

  start(ratePerHour: number, at: number = this.now()): void {
    if (this.since !== null) this.stop(at)
    this.rate = ratePerHour
    this.since = at
  }

  stop(at: number = this.now()): void {
    if (this.since === null) return
    this.accumulated += (Math.max(0, at - this.since) / 3_600_000) * this.rate
    this.since = null
  }

  usd(at: number = this.now()): number {
    const live = this.since === null ? 0 : (Math.max(0, at - this.since) / 3_600_000) * this.rate
    return this.accumulated + live
  }

  get running(): boolean {
    return this.since !== null
  }
}
