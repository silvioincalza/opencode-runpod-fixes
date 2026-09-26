import type { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import type { Phase } from "../../../core/domain/endpoint.ts"
import type { ModelStatus, NoticeLevel, StateEvent, StatusReport } from "../../../core/domain/events.ts"
import type { GpuOption, ProvisionOverrides, ProvisionProposal } from "../../../core/domain/provision.ts"
import type { Quote } from "../../../core/domain/quote.ts"

export const PhaseSchema: z.ZodType<Phase> = z.enum(["cold", "confirming", "creating", "warming", "ready", "idle", "deleting", "error"])
const RateSourceSchema = z.enum(["catalog", "fallback"])

export const QuoteSchema: z.ZodType<Quote> = z.object({
  modelID: z.string(),
  hf: z.string(),
  gpu: z.string(),
  gpuLabel: z.string(),
  gpuCount: z.number().int().min(1),
  ratePerHour: z.number(),
  rateSource: RateSourceSchema,
  weightsGb: z.number().nullable(),
  estColdStartSec: z.number(),
  idleTimeout: z.number(),
  idleWindowUsd: z.number(),
  warnings: z.array(z.string()),
  blocked: z.string().nullable(),
})

export const GpuOptionSchema: z.ZodType<GpuOption> = z.object({
  pool: z.string(),
  label: z.string(),
  ratePerHour: z.number(),
  rateSource: RateSourceSchema,
  vramGb: z.number().nullable(),
  fits: z.boolean().nullable(),
  estColdStartSec: z.number(),
  current: z.boolean(),
})

export const ProvisionProposalSchema: z.ZodType<ProvisionProposal> = z.object({
  quote: QuoteSchema,
  gpuOptions: z.array(GpuOptionSchema),
  idleTimeoutChoices: z.array(z.number()),
})

export const ProvisionOverridesSchema: z.ZodType<ProvisionOverrides> = z.object({
  gpu: z.string().optional(),
  idleTimeout: z.number().int().optional(),
})

// `satisfies`, not a `:` annotation: keeps the concrete ZodObject type the RPC event-schema union needs (see task-10-report.md).
export const StateEventSchema = z.object({
  modelID: z.string(),
  phase: PhaseSchema,
  detail: z.string().nullable(),
  elapsedSec: z.number().nullable(),
  spendUsd: z.number(),
  ratePerHour: z.number(),
  gpu: z.string(),
  gpuLabel: z.string(),
}) satisfies z.ZodType<StateEvent>

export const ModelStatusSchema: z.ZodType<ModelStatus> = z.object({
  modelID: z.string(),
  phase: PhaseSchema,
  detail: z.string().nullable(),
  spendUsd: z.number(),
  ratePerHour: z.number(),
  gpu: z.string(),
  gpuLabel: z.string(),
  endpointID: z.string().nullable(),
  gpuCount: z.number().int(),
  billedUsd: z.number().nullable(),
  lastRequestAt: z.number().nullable(),
  workers: z.object({ initializing: z.number(), running: z.number(), idle: z.number(), throttled: z.number() }).nullable(),
})

export const StatusReportSchema: z.ZodType<StatusReport> = z.object({
  models: z.array(ModelStatusSchema),
  orphans: z.array(z.object({ id: z.string(), name: z.string() })),
})

export const NoticeLevelSchema: z.ZodType<NoticeLevel> = z.enum(["info", "warning", "error"])
export const NoticeSchema = z.object({ level: NoticeLevelSchema, message: z.string() })
export type Notice = z.infer<typeof NoticeSchema>

/** RPC contract shared by the server plugin (`ctx.rpc.register`) and the TUI plugin (`client.rpc`). */
export const RunpodRpc = {
  id: "runpod",
  methods: {
    status: { input: z.object({}), output: StatusReportSchema },
    up: { input: z.object({ modelID: z.string() }), output: z.object({ baseURL: z.string() }) },
    down: { input: z.object({ modelID: z.string().optional() }), output: z.object({ deleted: z.array(z.string()) }) },
    confirm: {
      input: z.object({ requestID: z.string(), accepted: z.boolean(), overrides: ProvisionOverridesSchema.optional() }),
      output: z.object({ ok: z.boolean() }),
    },
  },
  events: {
    "confirm.requested": { schema: z.object({ requestID: z.string(), proposal: ProvisionProposalSchema }) },
    state: { schema: StateEventSchema },
    notice: { schema: NoticeSchema },
  },
} as const satisfies Rpc.PortableDefinition
