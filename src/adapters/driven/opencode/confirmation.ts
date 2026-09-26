import { randomUUID } from "node:crypto"
import type { ProvisionDecision, ProvisionProposal } from "../../../core/domain/provision.ts"
import type { ConfirmationPort } from "../../../core/ports/confirmation.ts"

interface Pending {
  resolve: (decision: ProvisionDecision) => void
  timer: unknown
}

export interface ConfirmTimers {
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (id: unknown) => void
}

/** Pairs an outgoing "please decide" request with the reply that arrives later over RPC. */
export class ConfirmBroker {
  private readonly timeoutMs: number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (id: unknown) => void
  private readonly pending = new Map<string, Pending>()

  constructor(timeoutMs: number, timers: ConfirmTimers = {}) {
    this.timeoutMs = timeoutMs
    this.setTimer = timers.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = timers.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>))
  }

  request(issue: (requestID: string) => void): Promise<ProvisionDecision> {
    const requestID = randomUUID()
    return new Promise<ProvisionDecision>((resolve) => {
      const timer = this.setTimer(() => {
        this.pending.delete(requestID)
        resolve({ accepted: false })
      }, this.timeoutMs)
      this.pending.set(requestID, { resolve, timer })
      issue(requestID)
    })
  }

  resolve(requestID: string, decision: ProvisionDecision): boolean {
    const entry = this.pending.get(requestID)
    if (!entry) return false
    this.pending.delete(requestID)
    this.clearTimer(entry.timer)
    entry.resolve(decision)
    return true
  }

  get size(): number {
    return this.pending.size
  }
}

/** ConfirmationPort over RPC: emit `confirm.requested`, wait for the `confirm` method to answer. */
export class RpcConfirmation implements ConfirmationPort {
  private readonly broker: ConfirmBroker
  private readonly emit: (requestID: string, proposal: ProvisionProposal) => void

  constructor(broker: ConfirmBroker, emit: (requestID: string, proposal: ProvisionProposal) => void) {
    this.broker = broker
    this.emit = emit
  }

  ask(proposal: ProvisionProposal): Promise<ProvisionDecision> {
    return this.broker.request((requestID) => this.emit(requestID, proposal))
  }
}
