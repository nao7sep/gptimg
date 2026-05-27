import { createLogger, safeLogError } from "../log/index.js";
import { runInspect } from "../local/inspect/index.js";
import type { InspectArgs, InspectResult } from "../types.js";
import { defaultLogPath, utcTimestamp } from "../internal/paths.js";
import type { VerbCallOptions } from "./options.js";

export interface InspectContext {
  profileDir: string;
  logDir: string;
}

export async function inspectImpl(
  ctx: InspectContext,
  args: InspectArgs,
  opts: VerbCallOptions = {},
): Promise<InspectResult> {
  const ts = utcTimestamp();
  const logPath = args.log ?? defaultLogPath(ctx.logDir, ts);
  const logger = await createLogger(logPath, "inspect");
  const signal = opts.signal;

  try {
    await logger.info("resolve", "inspect start", {
      input: args.in,
      mode: args.mode ?? "outer",
      key: args.key ?? "auto",
    });
    const stats = await runInspect(args, { signal });
    await logger.info("stats", "inspect complete", { stats });
    return {
      input: args.in,
      stats,
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
