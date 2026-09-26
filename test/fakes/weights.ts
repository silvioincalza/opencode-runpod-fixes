import type { WeightsInfoPort } from "../../src/core/ports/weights-info.ts"

export class FakeWeights implements WeightsInfoPort {
  value: number | null
  calls = 0
  constructor(value: number | null = 31.6) {
    this.value = value
  }
  async weightsGb(): Promise<number | null> {
    this.calls++
    return this.value
  }
}
