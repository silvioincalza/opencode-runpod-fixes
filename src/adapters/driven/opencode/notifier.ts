import type { NoticeLevel, StateEvent } from "../../../core/domain/events.ts"
import type { NotifierPort } from "../../../core/ports/notifier.ts"

export interface NotifierEmit {
  state(event: StateEvent): void
  notice(level: NoticeLevel, message: string): void
}

/** Publishes core state changes as RPC events; the composition root supplies the emit functions. */
export class RpcNotifier implements NotifierPort {
  private readonly emit: NotifierEmit

  constructor(emit: NotifierEmit) {
    this.emit = emit
  }

  state(event: StateEvent): void {
    this.emit.state(event)
  }

  notice(level: NoticeLevel, message: string): void {
    this.emit.notice(level, message)
  }
}
