import { EndpointService, type ServicePorts } from "../../src/core/application/endpoint-service.ts"
import type { ModelConfig, Settings } from "../../src/core/domain/model.ts"
import type { ProvisionDecision } from "../../src/core/domain/provision.ts"
import { FakeCatalog } from "./catalog.ts"
import { FakeClock } from "./clock.ts"
import { FakeCompute } from "./compute.ts"
import { ScriptedConfirmation, accept } from "./confirmation.ts"
import { RecordingLogger } from "./logger.ts"
import { RecordingNotifier } from "./notifier.ts"
import { FakePublisher } from "./publisher.ts"
import { FakeRecipe } from "./recipe.ts"
import { InMemoryStateStore } from "./store.ts"
import { FakeWeights } from "./weights.ts"

export function sampleModel(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: "m",
    name: "Model M",
    hf: "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8",
    gpu: "AMPERE_48",
    gpuCount: 1,
    context: 65536,
    output: 8192,
    tools: true,
    family: null,
    toolParser: undefined,
    reasoningParser: undefined,
    quantization: "fp8",
    weightsGb: null,
    idleTimeout: null,
    env: {},
    ...overrides,
  }
}

export function sampleSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    confirm: true,
    confirmTimeoutSec: 120,
    idleTimeout: 120,
    workersMax: 1,
    executionTimeoutSec: 600,
    coldStartTimeoutSec: 600,
    deleteOnExit: false,
    adoptExisting: true,
    maxHourlyRate: null,
    dataCenterIds: [],
    minCudaVersion: "12.8",
    workerImage: "runpod/worker-v1-vllm:v2.27.2",
    flashboot: true,
    models: [sampleModel()],
    ...overrides,
  }
}

export interface Harness {
  clock: FakeClock
  compute: FakeCompute
  catalog: FakeCatalog
  weights: FakeWeights
  recipe: FakeRecipe
  store: InMemoryStateStore
  confirmation: ScriptedConfirmation
  notifier: RecordingNotifier
  publisher: FakePublisher
  logger: RecordingLogger
  settings: Settings
  service: EndpointService
}

export function harness(
  settingsOverrides: Partial<Settings> = {},
  opts: { answers?: ProvisionDecision[]; weights?: number | null; compute?: boolean } = {},
): Harness {
  const settings = sampleSettings(settingsOverrides)
  const clock = new FakeClock()
  const compute = new FakeCompute()
  const catalog = new FakeCatalog()
  const weights = new FakeWeights(opts.weights === undefined ? 31.6 : opts.weights)
  const recipe = new FakeRecipe()
  const store = new InMemoryStateStore()
  const confirmation = new ScriptedConfirmation(opts.answers ?? [accept()])
  const notifier = new RecordingNotifier()
  const publisher = new FakePublisher()
  const logger = new RecordingLogger()
  const ports: ServicePorts = {
    compute: opts.compute === false ? null : compute,
    catalog,
    weights,
    recipe,
    store,
    clock,
    confirmation,
    notifier,
    publisher,
    logger,
  }
  return { clock, compute, catalog, weights, recipe, store, confirmation, notifier, publisher, logger, settings, service: new EndpointService(settings, ports) }
}
