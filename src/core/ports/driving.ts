import type { StatusReport } from "../domain/events.ts"

/** Driving port used by the model.request hook: make the model reachable and return its inference base URL. */
export interface ModelRoutingPort {
  ensureReady(modelID: string, opts?: { skipConfirm?: boolean }): Promise<string>
}

/** Driving port used by commands and RPC methods. */
export interface OperationsPort {
  status(): Promise<StatusReport>
  up(modelID: string): Promise<string>
  down(modelID?: string): Promise<string[]>
}

/** Driving port used by the plugin lifecycle. */
export interface LifecyclePort {
  start(): Promise<void>
  stop(budgetMs?: number): Promise<void>
}
