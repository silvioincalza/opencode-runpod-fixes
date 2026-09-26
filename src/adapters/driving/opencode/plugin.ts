import { Plugin } from "@opencode/plugin"
import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import { EndpointService } from "../../../core/application/endpoint-service.ts"
import { HfWeightsInfo } from "../../driven/huggingface/weights-info.ts"
import { OpencodeCatalogPublisher } from "../../driven/opencode/catalog-publisher.ts"
import { ConfirmBroker, RpcConfirmation } from "../../driven/opencode/confirmation.ts"
import { RpcNotifier } from "../../driven/opencode/notifier.ts"
import { OpencodeStateStore } from "../../driven/opencode/state-store.ts"
import { RunpodComputeProvider } from "../../driven/runpod/compute-provider.ts"
import { RunpodHttp } from "../../driven/runpod/http.ts"
import { RunpodPriceCatalog } from "../../driven/runpod/price-catalog.ts"
import { SystemClock } from "../../driven/system/clock.ts"
import { ConsoleLogger } from "../../driven/system/logger.ts"
import { VllmWorkerRecipe } from "../../driven/vllm/recipe.ts"
import { RunpodRpc } from "../rpc/contract.ts"
import { registerCommands } from "./commands.ts"
import { resolveSettings } from "./config.ts"
import { PROVIDER_ID, buildModelInfo, buildProviderInfo } from "./provider-catalog.ts"

/**
 * Composition root. The only file allowed to import driven adapters: it builds them,
 * hands them to the core as ports, and connects opencode's driving surfaces.
 */
export default Plugin.define({
  id: "runpod",
  async setup(ctx) {
    const logger = new ConsoleLogger("[runpod]")
    const clock = new SystemClock()
    const knownPools = new RunpodPriceCatalog(null, clock).knownPools()
    const { settings, secrets } = resolveSettings(ctx.options, { knownPools })

    // An explicit secret option that does not resolve is not replaced by the environment (Task 12); say so up front.
    const rawOptions = (ctx.options ?? {}) as { apiKey?: unknown; hfToken?: unknown }
    if (rawOptions.apiKey !== undefined && secrets.apiKey === null) logger.warn("options.apiKey is set but did not resolve — check the referenced env var or file")
    if (rawOptions.hfToken !== undefined && secrets.hfToken === null) logger.warn("options.hfToken is set but did not resolve — check the referenced env var or file")

    const http = secrets.apiKey ? new RunpodHttp({ apiKey: secrets.apiKey }) : null
    const compute = http ? new RunpodComputeProvider(http) : null
    const catalog = new RunpodPriceCatalog(http, clock)
    const broker = new ConfirmBroker(settings.confirmTimeoutSec * 1000)
    const publisher = new OpencodeCatalogPublisher(() => ctx.provider.reload())

    let registration: RpcRegistration<typeof RunpodRpc> | undefined
    const fire = (promise: Promise<void> | undefined) => {
      promise?.catch((error: unknown) => logger.warn("rpc emit failed", { error: String(error) }))
    }

    const service = new EndpointService(settings, {
      compute,
      catalog,
      weights: new HfWeightsInfo({ token: secrets.hfToken }),
      recipe: new VllmWorkerRecipe(secrets.hfToken),
      store: new OpencodeStateStore(ctx.storage),
      clock,
      confirmation: new RpcConfirmation(broker, (requestID, proposal) => fire(registration?.events.emit("confirm.requested", { requestID, proposal }))),
      notifier: new RpcNotifier({
        state: (event) => fire(registration?.events.emit("state", event)),
        notice: (level, message) => fire(registration?.events.emit("notice", { level, message })),
      }),
      publisher,
      logger,
    })

    registration = await ctx.rpc.register(RunpodRpc, {
      status: async () => service.status(),
      up: async ({ modelID }) => ({ baseURL: await service.up(modelID) }),
      down: async ({ modelID }) => ({ deleted: await service.down(modelID) }),
      confirm: async ({ requestID, accepted, overrides }) => ({
        ok: broker.resolve(requestID, accepted ? { accepted: true, overrides: overrides ?? {} } : { accepted: false }),
      }),
    })

    // Static models are visible immediately; start() republishes with variants and runtime additions.
    publisher.seed(settings.models.map((config) => ({ config, variants: [] })))
    await ctx.provider.transform((editor) => {
      editor.add({ info: buildProviderInfo(secrets.apiKey), models: publisher.current.map(buildModelInfo) })
    })

    await ctx.session.hook(
      "model.request",
      async (event) => {
        const variant = event.model.variant
        event.baseURL = await service.ensureReady(event.model.id, variant === undefined ? {} : { gpu: variant })
      },
      { providerID: PROVIDER_ID },
    )

    const reply = async (sessionID: string, text: string) => {
      fire(registration?.events.emit("notice", { level: "info", message: text }))
      await ctx.session.synthetic({ sessionID, text })
    }

    await registerCommands(
      {
        command: {
          transform: (callback) =>
            ctx.command.transform((editor) =>
              callback({
                add: (definition) =>
                  editor.add({
                    name: definition.name,
                    description: definition.description,
                    execute: (input) => definition.execute({ sessionID: input.sessionID, prompt: { text: input.prompt.text } }),
                  }),
              }),
            ),
        },
      },
      service,
      reply,
    )

    service.start().catch((error: unknown) => logger.warn("startup failed", { error: String(error) }))

    return async () => {
      await service.stop(10_000)
      await registration?.dispose()
    }
  },
})
