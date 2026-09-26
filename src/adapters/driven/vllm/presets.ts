export interface FamilyPreset {
  /** vLLM TOOL_CALL_PARSER; null = no tool parser. */
  readonly toolParser: string | null
  /** vLLM REASONING_PARSER; null = none. */
  readonly reasoningParser: string | null
}

export const FAMILIES: Readonly<Record<string, FamilyPreset>> = {
  "qwen3-coder": { toolParser: "qwen3_xml", reasoningParser: null },
  qwen3: { toolParser: "hermes", reasoningParser: "qwen3" },
  "glm-4.7": { toolParser: "glm47", reasoningParser: "glm47" },
  "glm-4.5": { toolParser: "glm45", reasoningParser: "glm45" },
  "gpt-oss": { toolParser: "openai", reasoningParser: null },
  devstral: { toolParser: "mistral", reasoningParser: null },
  mistral: { toolParser: "mistral", reasoningParser: null },
  llama3: { toolParser: "llama3_json", reasoningParser: null },
  "deepseek-v3": { toolParser: "deepseek_v3", reasoningParser: "deepseek_r1" },
}

const FAMILY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/qwen3[-_.]?coder/i, "qwen3-coder"],
  [/qwen3/i, "qwen3"],
  [/glm[-_]?4\.7/i, "glm-4.7"],
  [/glm[-_]?4\.[56]/i, "glm-4.5"],
  [/gpt[-_]?oss/i, "gpt-oss"],
  [/devstral/i, "devstral"],
  [/mistral|mixtral|magistral/i, "mistral"],
  [/llama[-_]?3/i, "llama3"],
  [/deepseek[-_]?(v3|r1)/i, "deepseek-v3"],
]

export function inferFamily(hf: string): string | null {
  for (const [pattern, family] of FAMILY_PATTERNS) if (pattern.test(hf)) return family
  return null
}

export function parsersFor(input: { family: string | null; toolParser?: string | null; reasoningParser?: string | null }): FamilyPreset {
  const preset = input.family === null ? undefined : FAMILIES[input.family]
  return {
    toolParser: input.toolParser === undefined ? (preset?.toolParser ?? null) : input.toolParser,
    reasoningParser: input.reasoningParser === undefined ? (preset?.reasoningParser ?? null) : input.reasoningParser,
  }
}
