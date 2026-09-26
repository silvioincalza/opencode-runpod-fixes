import type { LoggerPort } from "../../../core/ports/logger.ts"

/** Logging must never throw into the caller (circular objects, bigints). */
function serialize(extra: Record<string, unknown>): string {
  try {
    return JSON.stringify(extra)
  } catch {
    return "[unserializable extra]"
  }
}

/** Writes prefixed lines to stderr (captured by the opencode server log). */
export class ConsoleLogger implements LoggerPort {
  private readonly prefix: string
  private readonly write: (line: string) => void

  constructor(prefix: string, write: (line: string) => void = (line) => console.error(line)) {
    this.prefix = prefix
    this.write = write
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this.write(this.line(message, extra))
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this.write(this.line(message, extra))
  }

  private line(message: string, extra?: Record<string, unknown>): string {
    return `${this.prefix} ${message}${extra ? ` ${serialize(extra)}` : ""}`
  }
}
