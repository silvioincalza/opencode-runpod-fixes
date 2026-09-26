import type { LoggerPort } from "../../src/core/ports/logger.ts"

export class RecordingLogger implements LoggerPort {
  lines: string[] = []
  info(message: string): void {
    this.lines.push(`info ${message}`)
  }
  warn(message: string): void {
    this.lines.push(`warn ${message}`)
  }
}
