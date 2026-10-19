import { verbDone, verbStart } from "../events/index.ts";
import type { RefusedResult } from "../refusal.ts";
import type { SdkContext } from "../context.ts";
import { withVerbLogger } from "../internal/local-verb.ts";
import { runFramecheck } from "../local/framecheck.ts";
import type { FramecheckArgs, FramecheckResult } from "../types.ts";
import type { VerbCallOptions } from "./options.ts";
import { validateFramecheckArgs } from "./schemas.ts";

export type FramecheckContext = SdkContext;

/**
 * framecheck — read-only alpha-coverage geometry. It writes nothing (no output
 * file, not even a debug image), so it is a pure measurement that touches the
 * filesystem only to read `in`. The verb layer adds the logger envelope and
 * stamps `input` onto the geometry the local pass computed.
 */
export async function framecheckImpl(
  ctx: FramecheckContext,
  args: FramecheckArgs,
  opts: VerbCallOptions = {},
): Promise<FramecheckResult | RefusedResult> {
  validateFramecheckArgs(args);
  const signal = opts.signal;

  return withVerbLogger(ctx, "framecheck", opts, async (logger) => {
    logger.emit("info", "resolve", verbStart({
      input: args.in,
      threshold: args.threshold ?? null,
      tolerance: args.tolerance ?? null,
      axes: args.axes ?? null,
    }));

    const result = await runFramecheck(
      { in: args.in, threshold: args.threshold, tolerance: args.tolerance, axes: args.axes },
      { signal },
    );

    logger.emit("info", "stats", verbDone({
      verdict: result.verdict,
      empty: result.empty,
      solidBBox: result.solidBBox,
      anyBBox: result.anyBBox,
      margins: result.margins,
      deltas: result.deltas,
      edgeContact: result.edgeContact,
    }));

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
      status: "completed" as const,
    };
  });
}
