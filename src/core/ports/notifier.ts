import type { NoticeLevel, StateEvent } from "../domain/events.ts"

export interface NotifierPort {
  state(event: StateEvent): void
  notice(level: NoticeLevel, message: string): void
}
