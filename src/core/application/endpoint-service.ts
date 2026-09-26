import { buildEndpointSpec, type EndpointRecord, type Phase } from "../domain/endpoint.ts"
import type { StateEvent } from "../domain/events.ts"
import { applyOverrides, idleTimeoutFor, type ModelConfig, type ModelOverrides, type Settings } from "../domain/model.ts"
import { buildProposal, gpuVariantsFor, type PoolPricing, type ProvisionOverrides } from "../domain/provision.ts"
import { DEFAULT_WEIGHTS_GB, buildQuote, type PoolRate, type Quote } from "../domain/quote.ts"
import { SpendMeter } from "../domain/spend-meter.ts"
import type { CatalogPublisherPort, PublishedModel } from "../ports/catalog-publisher.ts"
import type { ClockPort } from "../ports/clock.ts"
import { ComputeError, type ComputeProviderPort } from "../ports/compute-provider.ts"
import type { ConfirmationPort } from "../ports/confirmation.ts"
import type { ModelRoutingPort } from "../ports/driving.ts"
import type { LoggerPort } from "../ports/logger.ts"
import type { NotifierPort } from "../ports/notifier.ts"
import type { PriceCatalogPort } from "../ports/price-catalog.ts"
import type { StateStorePort } from "../ports/state-store.ts"
import type { WeightsInfoPort } from "../ports/weights-info.ts"
import type { WorkerRecipePort } from "../ports/worker-recipe.ts"

/** Extra time after the provider's idle timeout before we assume the worker scaled to zero. */
export const IDLE_GRACE_MS = 15_000
export const HEALTH_POLL_MS = 3_000
export const WARMUP_RETRY_MS = 5_000

export interface ServicePorts {
  compute: ComputeProviderPort | null
  catalog: PriceCatalogPort
  weights: WeightsInfoPort
  recipe: WorkerRecipePort
  store: StateStorePort
  clock: ClockPort
  confirmation: ConfirmationPort
  notifier: NotifierPort
  publisher: CatalogPublisherPort
  logger: LoggerPort
}

interface ModelState {
  model: ModelConfig
  phase: Phase
  detail: string | null
  record: EndpointRecord | null
  inflight: Promise<string> | null
  lastRequestAt: number | null
  idleTimer: unknown
  meter: SpendMeter
  rate: PoolRate | null
}

interface Priced {
  quote: Quote
  weightsGb: number | null
  rate: PoolRate
}

const round = (n: number) => Math.round(n * 1000) / 1000
export const recordKey = (modelID: string) => `endpoints/${modelID}`
export const weightsKey = (hf: string) => `weights/${hf}`
export const overridesKey = (modelID: string) => `overrides/${modelID}`
export const modelKey = (modelID: string) => `models/${modelID}`

export class EndpointService implements ModelRoutingPort {
  protected readonly settings: Settings
  protected readonly ports: ServicePorts
  protected readonly states = new Map<string, ModelState>()
  /** Models added at runtime are persisted whole under models/<id>; static models persist overrides/<id>. */
  protected readonly runtimeIDs = new Set<string>()

  constructor(settings: Settings, ports: ServicePorts) {
    this.settings = settings
    this.ports = ports
    for (const model of settings.models) this.newState(model)
  }

  phase(modelID: string): Phase {
    return this.state(modelID).phase
  }

  async ensureReady(modelID: string, opts: { skipConfirm?: boolean; gpu?: string } = {}): Promise<string> {
    const st = this.state(modelID)
    if (st.inflight) return st.inflight
    const run = this.run(st, opts).finally(() => {
      st.inflight = null
    })
    st.inflight = run
    return run
  }

  // ---- internals -------------------------------------------------------

  protected newState(model: ModelConfig): ModelState {
    const st: ModelState = {
      model,
      phase: "cold",
      detail: null,
      record: null,
      inflight: null,
      lastRequestAt: null,
      idleTimer: null,
      meter: new SpendMeter(() => this.ports.clock.now()),
      rate: null,
    }
    this.states.set(model.id, st)
    return st
  }

  protected state(modelID: string): ModelState {
    const st = this.states.get(modelID)
    if (!st) throw new Error(`RunPod: model "${modelID}" is not configured (options.models or /runpod-add)`)
    return st
  }

  protected compute(): ComputeProviderPort {
    if (!this.ports.compute) {
      throw new Error("RunPod: no API key configured — set options.apiKey or the RUNPOD_API_KEY environment variable.")
    }
    return this.ports.compute
  }

  private async run(st: ModelState, opts: { skipConfirm?: boolean }): Promise<string> {
    const compute = this.compute()
    if (!st.record) {
      try {
        await this.provision(st, opts, compute)
      } catch (error) {
        // Every failure before the endpoint is usable ends in `cold` (paths that already reset are left alone).
        if (st.phase === "confirming" || st.phase === "creating") this.setPhase(st, "cold", `provisioning failed: ${(error as Error).message}`)
        throw error
      }
    }
    if (st.phase !== "ready") await this.warm(st, compute)
    this.touch(st)
    return compute.inferenceBaseURL(st.record!.endpointID)
  }

  /** Quote → (proposal → decision → validated, re-priced, persisted overrides) → create. */
  private async provision(st: ModelState, opts: { skipConfirm?: boolean }, compute: ComputeProviderPort): Promise<void> {
    let priced = await this.price(st.model)
    st.rate = priced.rate
    if (priced.quote.blocked) throw new Error(`RunPod: refusing to provision ${st.model.id}: ${priced.quote.blocked}`)
    if (this.settings.confirm && !opts.skipConfirm) {
      this.setPhase(st, "confirming", `waiting for confirmation · ${priced.quote.gpuLabel} · $${priced.quote.ratePerHour.toFixed(2)}/h`)
      const proposal = buildProposal({ quote: priced.quote, model: st.model, pricing: await this.pricing(), weightsGb: priced.weightsGb })
      const decision = await this.ports.confirmation.ask(proposal)
      if (!decision.accepted) {
        this.setPhase(st, "cold", "provisioning declined")
        throw new Error(
          `RunPod: provisioning of ${st.model.id} was declined or not confirmed within ${this.settings.confirmTimeoutSec}s. ` +
            `Run /runpod-up ${st.model.id} to provision without the dialog, or set options.confirm=false.`,
        )
      }
      const overrides = this.changedOverrides(st.model, decision.overrides)
      if (overrides) {
        this.validateOverrides(overrides)
        const candidate = applyOverrides(st.model, overrides)
        const repriced = await this.price(candidate)
        if (repriced.quote.blocked) {
          this.setPhase(st, "cold", `refused: ${repriced.quote.blocked}`)
          throw new Error(`RunPod: refusing to provision ${st.model.id}: ${repriced.quote.blocked}`)
        }
        await this.applyOverridesTo(st, overrides)
        priced = repriced
        st.rate = repriced.rate
      }
    }
    await this.create(st, priced, compute)
  }

  /** Only the parts of a dialog decision that differ from the effective config. */
  private changedOverrides(model: ModelConfig, chosen: ProvisionOverrides): ModelOverrides | null {
    const overrides: ModelOverrides = {}
    if (chosen.gpu !== undefined && chosen.gpu !== model.gpu) overrides.gpu = chosen.gpu
    if (chosen.idleTimeout !== undefined && chosen.idleTimeout !== idleTimeoutFor(model, this.settings)) overrides.idleTimeout = chosen.idleTimeout
    return Object.keys(overrides).length > 0 ? overrides : null
  }

  protected validateOverrides(overrides: ModelOverrides): void {
    const pools = this.ports.catalog.knownPools()
    if (overrides.gpu !== undefined && !pools.includes(overrides.gpu)) {
      throw new Error(`RunPod: unknown GPU pool "${overrides.gpu}" (known: ${pools.join(", ")})`)
    }
    const idle = overrides.idleTimeout
    if (idle !== undefined && idle !== null && (!Number.isInteger(idle) || idle < 1 || idle > 3600)) {
      throw new Error("RunPod: idleTimeout must be an integer between 1 and 3600 seconds")
    }
    if (overrides.gpuCount !== undefined && (!Number.isInteger(overrides.gpuCount) || overrides.gpuCount < 1 || overrides.gpuCount > 8)) {
      throw new Error("RunPod: gpuCount must be an integer between 1 and 8")
    }
    if (overrides.context !== undefined && (!Number.isInteger(overrides.context) || overrides.context < 1024)) {
      throw new Error("RunPod: context must be an integer ≥ 1024")
    }
    if (overrides.output !== undefined && (!Number.isInteger(overrides.output) || overrides.output < 256)) {
      throw new Error("RunPod: output must be an integer ≥ 256")
    }
  }

  /** Applies validated overrides to the in-memory config, persists them and republishes the catalog. */
  protected async applyOverridesTo(st: ModelState, overrides: ModelOverrides): Promise<void> {
    const next = applyOverrides(st.model, overrides)
    if (this.runtimeIDs.has(st.model.id)) {
      await this.ports.store.set(modelKey(st.model.id), next)
    } else {
      const stored = (await this.ports.store.get<ModelOverrides>(overridesKey(st.model.id))) ?? {}
      await this.ports.store.set(overridesKey(st.model.id), { ...stored, ...overrides })
    }
    st.model = next
    st.rate = null
    await this.publish()
  }

  /** Every known pool priced; pools whose lookup fails are skipped. */
  protected async pricing(): Promise<PoolPricing[]> {
    const out: PoolPricing[] = []
    for (const pool of this.ports.catalog.knownPools()) {
      try {
        out.push({ pool, rate: await this.ports.catalog.rate(pool) })
      } catch (error) {
        this.ports.logger.warn("price lookup failed", { pool, error: String(error) })
      }
    }
    return out
  }

  /** Publishes the effective model list with GPU variants; never throws. */
  protected async publish(): Promise<void> {
    try {
      const pricing = await this.pricing()
      const models: PublishedModel[] = [...this.states.values()].map((st) => ({ config: st.model, variants: gpuVariantsFor(st.model, pricing) }))
      await this.ports.publisher.publish(models)
    } catch (error) {
      this.ports.logger.warn("catalog publish failed", { error: String(error) })
    }
  }

  protected async rateFor(model: ModelConfig): Promise<PoolRate> {
    try {
      return await this.ports.catalog.rate(model.gpu)
    } catch (error) {
      this.ports.logger.warn("price lookup failed", { pool: model.gpu, error: String(error) })
      return { ratePerHour: 0, source: "fallback", vramGb: null, label: model.gpu }
    }
  }

  private async price(model: ModelConfig): Promise<Priced> {
    const rate = await this.rateFor(model)
    const weightsGb = model.weightsGb ?? (await this.weightsGb(model))
    return { quote: buildQuote({ model, settings: this.settings, rate, weightsGb }), weightsGb, rate }
  }

  protected async weightsGb(model: ModelConfig): Promise<number | null> {
    const cached = await this.ports.store.get<number>(weightsKey(model.hf))
    if (typeof cached === "number") return cached
    let size: number | null = null
    try {
      size = await this.ports.weights.weightsGb(model)
    } catch (error) {
      this.ports.logger.warn("weights lookup failed", { hf: model.hf, error: String(error) })
    }
    if (size !== null) await this.ports.store.set(weightsKey(model.hf), size)
    return size
  }

  private async create(st: ModelState, priced: Priced, compute: ComputeProviderPort): Promise<void> {
    this.setPhase(st, "creating", `creating endpoint on ${priced.quote.gpuLabel}`)
    const recipe = this.ports.recipe.recipe(st.model, this.settings, priced.weightsGb ?? DEFAULT_WEIGHTS_GB)
    const spec = buildEndpointSpec(st.model, this.settings, recipe)
    let created: { id: string }
    try {
      created = await compute.create(spec)
    } catch (error) {
      this.setPhase(st, "cold", `create failed: ${(error as Error).message}`)
      throw error
    }
    st.record = {
      endpointID: created.id,
      name: spec.name,
      modelID: st.model.id,
      gpu: st.model.gpu,
      gpuCount: st.model.gpuCount,
      hash: spec.hash,
      createdAt: this.ports.clock.now(),
      spendUsd: 0,
    }
    await this.ports.store.set(recordKey(st.model.id), st.record)
    this.ports.logger.info("endpoint created", { modelID: st.model.id, endpointID: created.id })
  }

  private async warm(st: ModelState, compute: ComputeProviderPort): Promise<void> {
    const record = st.record!
    const clock = this.ports.clock
    const started = clock.now()
    if (!st.rate) st.rate = await this.rateFor(st.model)
    st.meter.start(this.hourly(st), started)
    this.setPhase(st, "warming", "starting worker", 0)
    const controller = new AbortController()
    const deadline = clock.setTimer(() => controller.abort(), this.settings.coldStartTimeoutSec * 1000)
    void this.pollHealth(st, record.endpointID, controller.signal, started, compute)
    let lastError: unknown = null
    try {
      while (!controller.signal.aborted) {
        try {
          await compute.warmup(record.endpointID, st.model.id, controller.signal)
          const elapsed = this.elapsed(started)
          this.setPhase(st, "ready", `ready in ${elapsed}s`, elapsed)
          return
        } catch (error) {
          if (controller.signal.aborted) break
          lastError = error
          if (error instanceof ComputeError && error.kind === "fatal") break
          this.ports.logger.warn("warm-up attempt failed, retrying", { modelID: st.model.id, error: String(error) })
          await clock.sleep(WARMUP_RETRY_MS)
        }
      }
      st.meter.stop(clock.now())
      const elapsed = this.elapsed(started)
      const reason = controller.signal.aborted
        ? `timed out after ${elapsed}s`
        : `failed after ${elapsed}s: ${(lastError as Error | null)?.message ?? "unknown error"}`
      const diagnostics = await compute.diagnostics(record.endpointID).catch(() => null)
      this.setPhase(st, "cold", `cold start ${reason}`)
      throw new Error(
        `RunPod: cold start of ${st.model.id} ${reason}. Endpoint ${record.endpointID} was kept; retry, or run /runpod-down ${st.model.id}.` +
          (diagnostics ? `\nWorker log tail:\n${diagnostics}` : ""),
      )
    } finally {
      clock.clearTimer(deadline)
      controller.abort()
    }
  }

  private async pollHealth(st: ModelState, endpointID: string, signal: AbortSignal, started: number, compute: ComputeProviderPort): Promise<void> {
    while (!signal.aborted) {
      await this.ports.clock.sleep(HEALTH_POLL_MS)
      if (signal.aborted || st.phase !== "warming") return
      try {
        const h = await compute.health(endpointID)
        if (signal.aborted || st.phase !== "warming") return
        this.setPhase(st, "warming", `workers: initializing ${h.initializing} · running ${h.running} · idle ${h.idle} · throttled ${h.throttled}`, this.elapsed(started))
      } catch (error) {
        this.ports.logger.warn("health poll failed", { endpointID, error: String(error) })
      }
    }
  }

  protected idleMs(st: ModelState): number {
    return idleTimeoutFor(st.model, this.settings) * 1000
  }

  protected touch(st: ModelState): void {
    st.lastRequestAt = this.ports.clock.now()
    if (st.idleTimer !== null) this.ports.clock.clearTimer(st.idleTimer)
    st.idleTimer = this.ports.clock.setTimer(() => this.onIdle(st), this.idleMs(st) + IDLE_GRACE_MS)
  }

  private onIdle(st: ModelState): void {
    st.idleTimer = null
    if (st.phase !== "ready" || st.lastRequestAt === null) return
    st.meter.stop(st.lastRequestAt + this.idleMs(st))
    this.setPhase(st, "idle", "worker scaled to zero")
    if (st.record) {
      st.record.spendUsd = round(st.meter.usd())
      void this.ports.store.set(recordKey(st.model.id), st.record)
    }
  }

  protected setPhase(st: ModelState, phase: Phase, detail: string | null, elapsedSec: number | null = null): void {
    st.phase = phase
    st.detail = detail
    const event: StateEvent = {
      modelID: st.model.id,
      phase,
      detail,
      elapsedSec,
      spendUsd: round(st.meter.usd()),
      ratePerHour: this.hourly(st),
      gpu: st.model.gpu,
      gpuLabel: st.rate?.label ?? st.model.gpu,
    }
    this.ports.notifier.state(event)
    this.ports.logger.info(`${st.model.id}: ${phase}${detail ? ` · ${detail}` : ""}`)
  }

  protected hourly(st: ModelState): number {
    return Math.round((st.rate?.ratePerHour ?? 0) * st.model.gpuCount * 1e4) / 1e4
  }

  protected elapsed(started: number): number {
    return Math.round((this.ports.clock.now() - started) / 1000)
  }
}
