import type { StatusReport } from "../domain/events.ts"
import type { ModelConfig, ModelOverrides } from "../domain/model.ts"

/** Driving port used by the model.request hook: make the model reachable and return its inference base URL. */
export interface ModelRoutingPort {
  /** `gpu` is the pool id of the selected variant; when it differs from the effective pool it is applied as an override first. */
  ensureReady(modelID: string, opts?: { skipConfirm?: boolean; gpu?: string }): Promise<string>
}

export interface AddModelInput {
  hf: string
  gpu?: string
  overrides?: ModelOverrides
}

/** Driving port used by commands and RPC methods. */
export interface OperationsPort {
  status(): Promise<StatusReport>
  up(modelID: string): Promise<string>
  down(modelID?: string): Promise<string[]>
  add(input: AddModelInput): Promise<ModelConfig>
  set(modelID: string, overrides: ModelOverrides): Promise<ModelConfig>
  /** Runtime models are removed; static models have their overrides reset. */
  remove(modelID: string): Promise<"removed" | "reset">
  models(): readonly ModelConfig[]
}

/** Driving port used by the plugin lifecycle. */
export interface LifecyclePort {
  start(): Promise<void>
  stop(budgetMs?: number): Promise<void>
}
