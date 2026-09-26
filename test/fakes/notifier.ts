import type { NoticeLevel, StateEvent } from "../../src/core/domain/events.ts"
import type { NotifierPort } from "../../src/core/ports/notifier.ts"

export class RecordingNotifier implements NotifierPort {
  events: StateEvent[] = []
  notices: { level: NoticeLevel; message: string }[] = []
  state(event: StateEvent): void {
    this.events.push(event)
  }
  notice(level: NoticeLevel, message: string): void {
    this.notices.push({ level, message })
  }
  get phases(): string[] {
    return this.events.map((e) => e.phase)
  }
}
