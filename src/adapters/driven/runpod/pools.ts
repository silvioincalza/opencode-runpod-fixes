export interface PoolInfo {
  readonly label: string
  readonly vramGb: number
  /** Flex worker $/h from runpod.io/pricing on 2026-09-26; used only when the live catalog is unavailable. */
  readonly fallbackUsdPerHour: number
}

/** RunPod serverless GPU pools. Keys are the `gpu.pools` ids accepted by POST /v2/serverless. */
export const POOLS: Readonly<Record<string, PoolInfo>> = {
  AMPERE_16: { label: "A4000/A4500 16GB", vramGb: 16, fallbackUsdPerHour: 0.58 },
  AMPERE_24: { label: "L4/A5000/3090 24GB", vramGb: 24, fallbackUsdPerHour: 0.69 },
  ADA_24: { label: "RTX 4090 24GB", vramGb: 24, fallbackUsdPerHour: 1.1 },
  ADA_32_PRO: { label: "RTX 5090 32GB", vramGb: 32, fallbackUsdPerHour: 1.58 },
  AMPERE_48: { label: "A6000/A40 48GB", vramGb: 48, fallbackUsdPerHour: 1.22 },
  ADA_48_PRO: { label: "L40/L40S/6000Ada 48GB", vramGb: 48, fallbackUsdPerHour: 1.75 },
  AMPERE_80: { label: "A100 80GB", vramGb: 80, fallbackUsdPerHour: 2.72 },
  ADA_80_PRO: { label: "H100 80GB", vramGb: 80, fallbackUsdPerHour: 4.79 },
  BLACKWELL_96: { label: "RTX PRO 6000 96GB", vramGb: 96, fallbackUsdPerHour: 3.49 },
  HOPPER_141: { label: "H200 141GB", vramGb: 141, fallbackUsdPerHour: 5.93 },
}
