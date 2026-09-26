import type { Phase } from "../../../core/domain/endpoint.ts"
import type { StateEvent, StatusReport } from "../../../core/domain/events.ts"
import type { ModelConfig } from "../../../core/domain/model.ts"
import type { GpuOption } from "../../../core/domain/provision.ts"
import { idleWindowUsd, type Quote } from "../../../core/domain/quote.ts"

export function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

export function formatQuote(q: Quote): string {
  const lines = [
    `${q.modelID} ← ${q.hf}`,
    `GPU: ${q.gpuLabel}${q.gpuCount > 1 ? ` ×${q.gpuCount}` : ""} at ${formatUsd(q.ratePerHour)}/h while a worker runs${q.rateSource === "fallback" ? " (static price table)" : ""}`,
    `Cold start ≈ ${formatDuration(q.estColdStartSec)}${q.weightsGb !== null ? ` for ≈${q.weightsGb} GB of weights` : ""}`,
    `Stays warm ${q.idleTimeout}s after each request ≈ ${formatUsd(q.idleWindowUsd)} per idle window`,
  ]
  for (const warning of q.warnings) lines.push(`Warning: ${warning}`)
  return lines.join("\n")
}

export function formatGpuOption(o: GpuOption): string {
  const fit = o.fits === null ? "fit unknown" : o.fits ? "fits" : "too small"
  const parts = [`${o.label} — ${formatUsd(o.ratePerHour)}/h${o.rateSource === "fallback" ? " (static price)" : ""}`, fit, `cold start ≈ ${formatDuration(o.estColdStartSec)}`]
  if (o.current) parts.push("current")
  return parts.join(" · ")
}

export function formatIdleChoice(seconds: number, ratePerHour: number): string {
  return `${formatDuration(seconds)} ≈ ${formatUsd(idleWindowUsd(ratePerHour, seconds))} per idle window`
}

const PHASE_LABELS: Record<Phase, string> = {
  cold: "cold",
  idle: "cold",
  confirming: "confirm?",
  creating: "creating",
  warming: "warming",
  ready: "warm",
  deleting: "deleting",
  error: "error",
}

export function phaseLabel(e: { phase: Phase; elapsedSec: number | null }): string {
  return e.phase === "warming" ? `warming ${e.elapsedSec ?? 0}s` : PHASE_LABELS[e.phase]
}

export function footerLabel(e: StateEvent | null): string {
  if (!e) return ""
  return `runpod ${e.gpuLabel} · ${phaseLabel(e)} · ${formatUsd(e.ratePerHour)}/h · ≈${formatUsd(e.spendUsd)}`
}

export function formatStatus(s: StatusReport): string {
  if (s.models.length === 0) return "RunPod: no models configured (options.models or /runpod-add)"
  const lines = s.models.map((m) => {
    const parts = [
      `${m.modelID}: ${m.phase}${m.endpointID ? ` [${m.endpointID}]` : ""}`,
      `${m.gpuLabel}${m.gpuCount > 1 ? ` ×${m.gpuCount}` : ""} ${formatUsd(m.ratePerHour)}/h`,
      `session ≈${formatUsd(m.spendUsd)}`,
    ]
    if (m.billedUsd !== null) parts.push(`billed ${formatUsd(m.billedUsd)}`)
    if (m.workers) parts.push(`workers ${m.workers.running} running / ${m.workers.idle} idle${m.workers.initializing > 0 ? ` / ${m.workers.initializing} starting` : ""}`)
    if (m.detail) parts.push(m.detail)
    return parts.join(" · ")
  })
  if (s.orphans.length > 0) lines.push(`Unmanaged oc-runpod-* endpoints: ${s.orphans.map((o) => `${o.name} [${o.id}]`).join(", ")}`)
  return lines.join("\n")
}

/** One-line effective configuration, used by /runpod-add, /runpod-set and /runpod-remove replies. */
export function formatModel(m: ModelConfig): string {
  const tri = (v: string | null | undefined) => (v === undefined ? "preset" : v === null ? "null" : v)
  return [
    `${m.id}: hf=${m.hf}`,
    `gpu=${m.gpu}`,
    `gpuCount=${m.gpuCount}`,
    `context=${m.context}`,
    `output=${m.output}`,
    `tools=${m.tools}`,
    `family=${m.family ?? "auto"}`,
    `toolParser=${tri(m.toolParser)}`,
    `reasoningParser=${tri(m.reasoningParser)}`,
    `quantization=${m.quantization ?? "null"}`,
    `weightsGb=${m.weightsGb ?? "auto"}`,
    `idleTimeout=${m.idleTimeout ?? "default"}`,
  ].join(" ")
}
