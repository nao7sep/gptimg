import path from "node:path";
import { existsSync } from "node:fs";
import { LocalOpError } from "../errors.js";
import { ensureOutputDir } from "../internal/output-files.js";
import { createLogger, safeLogError } from "../log/index.js";
import {
  parseOverColor,
  runCompose,
  type ComposeOver,
} from "../local/compose.js";
import type { ComposeArgs, ComposeResult } from "../types.js";
import { defaultLogPath, utcTimestamp } from "../internal/paths.js";
import type { VerbCallOptions } from "./options.js";

export interface ComposeContext {
  profileDir: string;
  logDir: string;
}

function inferStem(filePath: string): string {
  const base = path.basename(filePath);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function defaultOutputName(input: string): string {
  return `${inferStem(input)}-composed.png`;
}

function checkOverwrite(filePath: string, allowOverwrite: boolean): void {
  if (!allowOverwrite && existsSync(filePath)) {
    throw new LocalOpError(
      "output.exists",
      `Output exists: ${filePath}. Use --overwrite to allow.`,
    );
  }
}

export async function composeImpl(
  ctx: ComposeContext,
  args: ComposeArgs,
  opts: VerbCallOptions = {},
): Promise<ComposeResult> {
  const ts = utcTimestamp();
  const logPath = args.log ?? defaultLogPath(ctx.logDir, ts);
  const logger = await createLogger(logPath, "compose");
  const signal = opts.signal;

  try {
    const inDir = path.dirname(args.in);
    const outDir = args.outDir ?? inDir;
    await ensureOutputDir(outDir);
    const outName = args.outName ?? defaultOutputName(args.in);
    const outPath = path.isAbsolute(outName) ? outName : path.join(outDir, outName);
    const overwrite = args.overwrite ?? false;
    checkOverwrite(outPath, overwrite);

    const over: ComposeOver | undefined = args.over
      ? parseOverColor(args.over)
      : undefined;

    await logger.info("resolve", "compose start", {
      input: args.in,
      mask: args.mask,
      out: outPath,
      over: over?.kind ?? "transparent",
      decontaminate: args.decontaminate ?? null,
    });

    const result = await runCompose(
      {
        in: args.in,
        mask: args.mask,
        out: outPath,
        over,
        decontaminate: args.decontaminate,
      },
      { signal },
    );
    await logger.info("write", "wrote composed image", {
      path: result.output,
      width: result.width,
      height: result.height,
      over: result.over,
    });

    return {
      input: args.in,
      mask: args.mask,
      output: result.output,
      width: result.width,
      height: result.height,
      over: result.over,
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
