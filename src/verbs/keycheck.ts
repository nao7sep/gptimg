import { normalizeHex } from "../color.js";
import {
  assertSingleFileAvailable,
  inferStem,
  resolveOutputPath,
  withVerbLogger,
} from "../internal/local-verb.js";
import { loadKeyFromSidecar } from "../local/chroma/sidecar-key.js";
import { runKeycheck } from "../local/keycheck.js";
import type { ChromaKeySource, KeycheckArgs, KeycheckResult } from "../types.js";
import type { VerbCallOptions } from "./options.js";
import { validateKeycheckArgs } from "./schemas.js";

export interface KeycheckContext {
  profileDir: string;
  logDir: string;
}

function defaultStem(input: string): string {
  return `${inferStem(input)}-keycheck`;
}

/**
 * Resolve the key spec to a concrete "#rrggbb" and record its provenance.
 * "from-sidecar" reads `request.chroma.color` from the generate sidecar beside
 * `in` (the same path `mask` uses); anything else is an explicit hex the schema
 * already shaped. keycheck has no "auto": there is no background left to sample.
 */
async function resolveKey(
  args: KeycheckArgs,
): Promise<{ key: string; keySource: ChromaKeySource }> {
  if (args.key === "from-sidecar") {
    return {
      key: normalizeHex(await loadKeyFromSidecar(args.in), "sidecar key"),
      keySource: "sidecar",
    };
  }
  return { key: normalizeHex(args.key, "key"), keySource: "explicit" };
}

export async function keycheckImpl(
  ctx: KeycheckContext,
  args: KeycheckArgs,
  opts: VerbCallOptions = {},
): Promise<KeycheckResult> {
  validateKeycheckArgs(args);
  const signal = opts.signal;

  return withVerbLogger(ctx, "keycheck", { log: args.log, onProgress: opts.onProgress }, async (logger) => {
    const { key, keySource } = await resolveKey(args);

    // The heatmap is the only file keycheck can write; with no heatmap it is a
    // pure measurement and touches the filesystem only to read `in`.
    let heatmapOut: string | undefined;
    if (args.heatmap) {
      heatmapOut = await resolveOutputPath(args, {
        inputForDir: args.in,
        stem: defaultStem(args.in),
        ext: "png",
      });
      assertSingleFileAvailable(heatmapOut, args.overwrite ?? false);
    }

    await logger.info("resolve", "keycheck start", {
      input: args.in,
      key,
      keySource,
      hueTolerance: args.hueTolerance ?? null,
      minSaturation: args.minSaturation ?? null,
      minValue: args.minValue ?? null,
      heatmap: args.heatmap ?? false,
    });

    const result = await runKeycheck(
      {
        in: args.in,
        key,
        hueTolerance: args.hueTolerance,
        minSaturation: args.minSaturation,
        minValue: args.minValue,
        maxEdgeResidueFraction: args.maxEdgeResidueFraction,
        maxInteriorResiduePixels: args.maxInteriorResiduePixels,
        heatmapOut,
      },
      { signal },
    );

    await logger.info("stats", "keycheck complete", {
      verdict: result.verdict,
      presentPixels: result.presentPixels,
      edgePixels: result.edgePixels,
      residuePixels: result.residuePixels,
      edgeResiduePixels: result.edgeResiduePixels,
      interiorResiduePixels: result.interiorResiduePixels,
      edgeResidueFraction: result.edgeResidueFraction,
      residueFraction: result.residueFraction,
      worstBBox: result.worstBBox,
      heatmapPath: result.heatmapPath,
    });

    return {
      input: args.in,
      key,
      keySource,
      width: result.width,
      height: result.height,
      presentPixels: result.presentPixels,
      edgePixels: result.edgePixels,
      residuePixels: result.residuePixels,
      edgeResiduePixels: result.edgeResiduePixels,
      interiorResiduePixels: result.interiorResiduePixels,
      edgeResidueFraction: result.edgeResidueFraction,
      residueFraction: result.residueFraction,
      worstBBox: result.worstBBox,
      hueTolerance: result.hueTolerance,
      minSaturation: result.minSaturation,
      minValue: result.minValue,
      verdict: result.verdict,
      heatmapPath: result.heatmapPath,
      logPath: logger.handle.path,
    };
  });
}
