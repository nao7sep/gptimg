import type { ChromaStats, InspectArgs } from "../../types.js";
import { detect } from "../chroma/detect.js";

/**
 * Local image inspection. Shares the chroma detection pipeline but performs
 * no writes — returns stats only.
 */
export async function runInspect(args: InspectArgs): Promise<ChromaStats> {
  const result = await detect({
    in: args.in,
    mode: args.mode,
    key: args.key,
    innerThreshold: args.innerThreshold,
    outerThreshold: args.outerThreshold,
    metric: args.metric,
    borderSample: args.borderSample,
    edgeBand: args.edgeBand,
    strictConfidence: args.strictConfidence,
  });
  return result.stats;
}
