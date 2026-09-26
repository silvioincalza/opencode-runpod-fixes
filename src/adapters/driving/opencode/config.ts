import { readFileSync } from "node:fs"
import { z } from "zod"
import { MODEL_ID_PATTERN, type ModelConfig, type ModelOverrides, type Settings } from "../../../core/domain/model.ts"

const HF_REPO = /^[\w.-]+\/[\w.-]+$/

export const ModelOptionsSchema = z.strictObject({
  name: z.string().min(1).optional(),
  hf: z.string().regex(HF_REPO, "expected a Hugging Face repo id like org/name"),
  gpu: z.string().min(1),
  gpuCount: z.number().int().min(1).max(8).default(1),
  context: z.number().int().min(1024).default(32768),
  output: z.number().int().min(256).default(8192),
  tools: z.boolean().default(true),
  family: z.string().min(1).nullable().optional(),
  toolParser: z.string().min(1).nullable().optional(),
  reasoningParser: z.string().min(1).nullable().optional(),
  quantization: z.string().min(1).nullable().optional(),
  weightsGb: z.number().positive().nullable().optional(),
  idleTimeout: z.number().int().min(1).max(3600).nullable().optional(),
  env: z.record(z.string(), z.string()).default({}),
})

export const OptionsSchema = z.strictObject({
  apiKey: z.string().optional(),
  hfToken: z.string().optional(),
  confirm: z.boolean().default(true),
  confirmTimeoutSec: z.number().int().min(5).default(120),
  idleTimeout: z.number().int().min(1).max(3600).default(120),
  workersMax: z.number().int().min(1).max(10).default(1),
  executionTimeoutSec: z.number().int().min(5).default(600),
  coldStartTimeoutSec: z.number().int().min(30).default(600),
  deleteOnExit: z.boolean().default(false),
  adoptExisting: z.boolean().default(true),
  maxHourlyRate: z.number().positive().optional(),
  dataCenterIds: z.array(z.string()).default([]),
  minCudaVersion: z.string().default("12.8"),
  workerImage: z.string().default("runpod/worker-v1-vllm:v2.27.2"),
  flashboot: z.boolean().default(true),
  models: z.record(z.string(), ModelOptionsSchema).default({}),
})

/** Runtime overrides (dialog, variants, /runpod-set): same fields, no defaults, `env` excluded. */
export const OverridesSchema = z.strictObject({
  name: z.string().min(1).optional(),
  hf: z.string().regex(HF_REPO, "expected a Hugging Face repo id like org/name").optional(),
  gpu: z.string().min(1).optional(),
  gpuCount: z.number().int().min(1).max(8).optional(),
  context: z.number().int().min(1024).optional(),
  output: z.number().int().min(256).optional(),
  tools: z.boolean().optional(),
  family: z.string().min(1).nullable().optional(),
  toolParser: z.string().min(1).nullable().optional(),
  reasoningParser: z.string().min(1).nullable().optional(),
  quantization: z.string().min(1).nullable().optional(),
  weightsGb: z.number().positive().nullable().optional(),
  idleTimeout: z.number().int().min(1).max(3600).nullable().optional(),
})

export const OVERRIDE_KEYS = ["name", "hf", "gpu", "gpuCount", "context", "output", "tools", "family", "toolParser", "reasoningParser", "quantization", "weightsGb", "idleTimeout"] as const
const NUMERIC_KEYS = new Set<string>(["gpuCount", "context", "output", "weightsGb", "idleTimeout"])
const BOOLEAN_KEYS = new Set<string>(["tools"])
const NULLABLE_KEYS = new Set<string>(["family", "toolParser", "reasoningParser", "quantization", "weightsGb", "idleTimeout"])

export class ConfigError extends Error {
  constructor(message: string) {
    super(`opencode-runpod config: ${message}`)
    this.name = "ConfigError"
  }
}

export type Env = Readonly<Record<string, string | undefined>>

export interface SecretDeps {
  env?: Env
  readFile?: (path: string) => string
}

export interface ResolveDeps extends SecretDeps {
  knownPools: readonly string[]
}

export interface Secrets {
  apiKey: string | null
  hfToken: string | null
}

/** Resolves `{env:NAME}` / `{file:PATH}` placeholders that opencode did not substitute itself. */
export function resolveSecret(value: string | undefined, deps: SecretDeps = {}): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  if (trimmed === "") return null
  const env = deps.env ?? process.env
  const envMatch = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(trimmed)
  if (envMatch) return env[envMatch[1]!]?.trim() || null
  const fileMatch = /^\{file:(.+)\}$/.exec(trimmed)
  if (fileMatch) {
    const read = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"))
    const path = fileMatch[1]!.replace(/^~(?=\/)/, env.HOME ?? "~")
    try {
      return read(path).trim() || null
    } catch (error) {
      throw new ConfigError(`cannot read ${path}: ${(error as Error).message}`)
    }
  }
  return trimmed
}

export function resolveSettings(raw: unknown, deps: ResolveDeps): { settings: Settings; secrets: Secrets } {
  const env = deps.env ?? process.env
  const parsed = OptionsSchema.safeParse(raw ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    throw new ConfigError(`${issue.path.join(".") || "options"}: ${issue.message}`)
  }
  const o = parsed.data
  const models: ModelConfig[] = []
  for (const [id, m] of Object.entries(o.models)) {
    if (!MODEL_ID_PATTERN.test(id)) throw new ConfigError(`models.${id}: id must match ${MODEL_ID_PATTERN}`)
    if (!deps.knownPools.includes(m.gpu)) {
      throw new ConfigError(`models.${id}.gpu: unknown pool "${m.gpu}" (known: ${deps.knownPools.join(", ")})`)
    }
    models.push({
      id,
      name: m.name ?? `${id} (RunPod)`,
      hf: m.hf,
      gpu: m.gpu,
      gpuCount: m.gpuCount,
      context: m.context,
      output: m.output,
      tools: m.tools,
      family: m.family ?? null,
      toolParser: m.toolParser,
      reasoningParser: m.reasoningParser,
      quantization: m.quantization ?? null,
      weightsGb: m.weightsGb ?? null,
      idleTimeout: m.idleTimeout ?? null,
      env: { ...m.env },
    })
  }
  const settings: Settings = {
    confirm: o.confirm,
    confirmTimeoutSec: o.confirmTimeoutSec,
    idleTimeout: o.idleTimeout,
    workersMax: o.workersMax,
    executionTimeoutSec: o.executionTimeoutSec,
    coldStartTimeoutSec: o.coldStartTimeoutSec,
    deleteOnExit: o.deleteOnExit,
    adoptExisting: o.adoptExisting,
    maxHourlyRate: o.maxHourlyRate ?? null,
    dataCenterIds: [...o.dataCenterIds],
    minCudaVersion: o.minCudaVersion,
    workerImage: o.workerImage,
    flashboot: o.flashboot,
    models,
  }
  const secrets: Secrets = {
    // The env fallback applies only when the option is absent: an explicit option that does not resolve means "no key",
    // never "some other key" (that would silently bill a different account).
    apiKey: o.apiKey === undefined ? env.RUNPOD_API_KEY?.trim() || null : resolveSecret(o.apiKey, deps),
    hfToken: o.hfToken === undefined ? env.HF_TOKEN?.trim() || null : resolveSecret(o.hfToken, deps),
  }
  return { settings, secrets }
}

/** Parses `/runpod-set` style `key=value` pairs; `null` clears a nullable key. */
export function parseOverrides(pairs: readonly string[]): ModelOverrides {
  const raw: Record<string, unknown> = {}
  for (const pair of pairs) {
    const eq = pair.indexOf("=")
    if (eq <= 0) throw new ConfigError(`expected key=value, got "${pair}"`)
    const key = pair.slice(0, eq)
    const value = pair.slice(eq + 1)
    if (!(OVERRIDE_KEYS as readonly string[]).includes(key)) throw new ConfigError(`unknown key "${key}" (allowed: ${OVERRIDE_KEYS.join(", ")})`)
    if (value === "null") {
      if (!NULLABLE_KEYS.has(key)) throw new ConfigError(`${key} cannot be null`)
      raw[key] = null
      continue
    }
    if (NUMERIC_KEYS.has(key)) {
      const n = Number(value)
      if (value.trim() === "" || !Number.isFinite(n)) throw new ConfigError(`${key}: expected a number, got "${value}"`)
      raw[key] = n
      continue
    }
    if (BOOLEAN_KEYS.has(key)) {
      if (value !== "true" && value !== "false") throw new ConfigError(`${key}: expected true or false`)
      raw[key] = value === "true"
      continue
    }
    raw[key] = value
  }
  const parsed = OverridesSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    throw new ConfigError(`${issue.path.join(".") || "override"}: ${issue.message}`)
  }
  return parsed.data as ModelOverrides
}
