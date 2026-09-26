import type { ProvisionDecision, ProvisionOverrides, ProvisionProposal } from "../../src/core/domain/provision.ts"
import type { ConfirmationPort } from "../../src/core/ports/confirmation.ts"

export const accept = (overrides: ProvisionOverrides = {}): ProvisionDecision => ({ accepted: true, overrides })
export const decline: ProvisionDecision = { accepted: false }

/** Answers in order; the last answer repeats. */
export class ScriptedConfirmation implements ConfirmationPort {
  answers: ProvisionDecision[]
  asked: ProvisionProposal[] = []
  gate: Promise<void> | null = null
  constructor(answers: ProvisionDecision[] = [accept()]) {
    this.answers = [...answers]
  }
  async ask(proposal: ProvisionProposal): Promise<ProvisionDecision> {
    this.asked.push(proposal)
    if (this.gate) await this.gate
    return this.answers.length > 1 ? this.answers.shift()! : (this.answers[0] ?? accept())
  }
}
