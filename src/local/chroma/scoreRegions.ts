import type { ChromaMode } from "../../types.js";
import type { ComponentProps } from "./components.js";

export interface ScoreInput {
  mode: ChromaMode;
  totalPixels: number;
  innerThreshold: number;
  /** Optional higher confidence gate for stricter region acceptance. */
  strictConfidence?: number;
}

export interface ScoredRegion {
  props: ComponentProps;
  accepted: boolean;
  /** Confidence in [0, 1]; higher is more likely to be backdrop. */
  confidence: number;
}

const MIN_AREA_FRACTION = 0.0005; // 0.05% of total pixels

function regionConfidence(meanDistance: number, innerThreshold: number): number {
  // Map meanDistance in [0, inner] → confidence in [1, 0] linearly.
  // Distances above the inner threshold yield 0 confidence.
  if (innerThreshold <= 0) return meanDistance === 0 ? 1 : 0;
  const c = 1 - meanDistance / innerThreshold;
  if (c < 0) return 0;
  if (c > 1) return 1;
  return c;
}

export function scoreRegions(
  components: ComponentProps[],
  input: ScoreInput,
): ScoredRegion[] {
  const minArea = Math.max(8, Math.floor(input.totalPixels * MIN_AREA_FRACTION));
  const strict = input.strictConfidence ?? 0;
  const out: ScoredRegion[] = [];
  for (let i = 1; i < components.length; i++) {
    const c = components[i]!;
    const confidence = regionConfidence(c.meanDistance, input.innerThreshold);
    let accepted = c.area >= minArea && confidence >= strict;
    if (accepted && input.mode === "outer" && !c.touchesBorder) {
      accepted = false;
    }
    out.push({ props: c, accepted, confidence });
  }
  return out;
}
