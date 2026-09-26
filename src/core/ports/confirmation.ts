import type { ProvisionDecision, ProvisionProposal } from "../domain/provision.ts"

export interface ConfirmationPort {
  /** Shows the proposal to the user; resolves with their decision (declined when unanswered). */
  ask(proposal: ProvisionProposal): Promise<ProvisionDecision>
}
