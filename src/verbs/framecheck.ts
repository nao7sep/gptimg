import { withVerbLogger } from "../internal/local-verb.js";
import { runFramecheck } from "../local/framecheck.js";
import type { FramecheckArgs, FramecheckResult } from "../types.js";
import type { VerbCallOptions } from "./options.js";
import { validateFramecheckArgs } from "./schemas.js";

export interface FramecheckContext {
  profileDir: string;
  logDir: string;
}

/**
 * framecheck — read-only alpha-coverage geometry. It writes nothing (no output
 * file, not even a debug image), so it is a pure measurement that touches the
 * filesystem only to read `in`. The verb layer adds the logger envelope and
 * stamps `input`/`logPath` onto the geometry the local pass computed.
 */
export async function framecheckImpl(
  ctx: FramecheckContext,
  args: FramecheckArgs,
  opts: VerbCallOptions = {},
): Promise<FramecheckResult> {
  validateFramecheckArgs(args);
  const signal = opts.signal;

  return withVerbLogger(ctx, "framecheck", { log: args.log, onProgress: opts.onProgress }, async (logger) => {
    await logger.info("resolve", "framecheck start", {
      input: args.in,
      threshold: args.threshold ?? null,
      tolerance: args.tolerance ?? null,
      axes: args.axes ?? null,
    });

    const result = await runFramecheck(
      { in: args.in, threshold: args.threshold, tolerance: args.tolerance, axes: args.axes },
      { signal },
    );

    await logger.info("stats", "framecheck complete", {
      verdict: result.verdict,
      empty: result.empty,
      solidBBox: result.solidBBox,
      anyBBox: result.anyBBox,
      margins: result.margins,
      deltas: result.deltas,
      edgeContact: result.edgeContact,
    });

    return {
      input: args.in,
      width: result.width,
      height: result.height,
      threshold: result.threshold,
      tolerance: result.tolerance,
      axes: result.axes,
      empty: result.empty,
      anyBBox: result.anyBBox,
      solidBBox: result.solidBBox,
      margins: result.margins,
      deltas: result.deltas,
      edgeContact: result.edgeContact,
      verdict: result.verdict,
      logPath: logger.handle.path,
    };
  });
}
