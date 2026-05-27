import path from "node:path";
import { createLogger, safeLogError } from "../log/index.js";
import { runChroma } from "../local/chroma/index.js";
import { visionImpl, type VisionContext } from "./vision.js";
import type { ChromaArgs, ChromaResult, VisionResult } from "../types.js";
import {
  defaultLogPath,
  utcTimestamp,
} from "../internal/paths.js";
import type { VerbCallOptions } from "./options.js";

export interface ChromaContext {
  profileDir: string;
  logDir: string;
}

export async function chromaImpl(
  ctx: ChromaContext,
  args: ChromaArgs,
  opts: VerbCallOptions = {},
): Promise<ChromaResult> {
  const ts = utcTimestamp();
  const logPath = args.log ?? defaultLogPath(ctx.logDir, ts);
  const logger = await createLogger(logPath, "chroma");
  const signal = opts.signal;

  try {
    await logger.info("resolve", "chroma start", {
      input: args.in,
      mode: args.mode ?? "outer",
      key: args.key ?? "auto",
    });

    const out = await runChroma(args, { signal });
    await logger.info("stats", "chroma complete", {
      output: out.imagePath,
      mask: out.maskPath,
      stats: out.stats,
    });

    let verify: VisionResult | undefined;
    const verifyThreshold = args.verifyThreshold ?? 0;
    if (args.verify && out.stats.removedFraction > verifyThreshold) {
      const visionCtx: VisionContext = {
        profileDir: ctx.profileDir,
        logDir: ctx.logDir,
      };
      await logger.info("request", "running internal vision verification", {
        threshold: verifyThreshold,
        removedFraction: out.stats.removedFraction,
      });
      verify = await visionImpl(
        visionCtx,
        {
          in: out.imagePath,
          check: args.verify,
          log: logger.handle.path,
          outDir: path.dirname(out.imagePath),
          outName: `${path.parse(out.imagePath).name}-verify`,
        },
        { signal },
      );
      await logger.info("response", "vision verification returned", {
        ok: verify.ok,
        score: verify.score,
      });
    }

    return {
      input: args.in,
      outputs: { image: out.imagePath, mask: out.maskPath },
      stats: out.stats,
      ...(verify ? { verify } : {}),
      logPath: logger.handle.path,
    };
  } catch (err) {
    await safeLogError(logger, (err as Error).message, {
      code: (err as { code?: string }).code ?? null,
    });
    throw err;
  } finally {
    await logger.close();
  }
}
