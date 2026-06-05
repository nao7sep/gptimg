/**
 * Shared building blocks for verbs. `withVerbLogger` is the single logger
 * envelope used by every verb — the local single-file ops (mask, compose,
 * trim, backplate, layer, …) and the provider-backed ones (generate, edit,
 * vision) and model install alike. The output-path helpers below are for the
 * local single-file ops; generate/edit have richer per-image-sidecar/output-
 * group orchestration in `output-group.ts`.
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { LocalOpError } from "../errors.js";
import { createLogger, safeLogError, type Logger } from "../log/index.js";
import { ensureOutputDir } from "./output-files.js";
import { defaultLogPath, utcTimestamp } from "./paths.js";
import type { LogEntry, LogVerb } from "../types.js";

/** Stem (basename without extension) of a file path. `foo/bar.png` → `bar`. */
export function inferStem(filePath: string): string {
  const base = path.basename(filePath);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Refuse to overwrite a single existing file unless explicitly allowed. The
 * group-scoped variant (`assertOutputGroupAvailable` / `assertStemAvailable`
 * in output-group.ts) is for generate/edit's multi-file artifact groups.
 */
export function assertSingleFileAvailable(
  filePath: string,
  allowOverwrite: boolean,
): void {
  if (!allowOverwrite && existsSync(filePath)) {
    throw new LocalOpError(
      "output.exists",
      `Output exists: ${filePath}. Use --overwrite to allow.`,
    );
  }
}

/**
 * Resolve {outDir, outName} args to a concrete absolute output path, creating
 * the directory if needed.
 *
 * - `outDir` defaults to `dirname(inputForDir)` when an input file path is
 *   given, otherwise to the current working directory. The CWD fallback is
 *   for verbs that take no input file (e.g. `backplate`).
 * - `outName` defaults to `defaults.outName`. An absolute outName overrides
 *   outDir entirely.
 */
export async function resolveOutputPath(
  args: { outDir?: string | undefined; outName?: string | undefined },
  defaults: { inputForDir?: string | undefined; outName: string },
): Promise<string> {
  const outDir =
    args.outDir ??
    (defaults.inputForDir !== undefined
      ? path.dirname(defaults.inputForDir)
      : process.cwd());
  await ensureOutputDir(outDir);
  const outName = args.outName ?? defaults.outName;
  return path.isAbsolute(outName) ? outName : path.join(outDir, outName);
}

export interface VerbLoggerOptions {
  /** Explicit log path. Falls back to `<ts>-gptimg.jsonl` under ctx.logDir. */
  log?: string | undefined;
  /** Timestamp for the default log filename — pass the verb's own `ts` when it
   * also stamps output names, so the log file and the outputs share it. */
  ts?: string | undefined;
  /** Progress sink: each info/warn stage event is forwarded here as it fires. */
  onProgress?: ((entry: LogEntry) => void) | undefined;
}

/**
 * The single logger envelope for every verb (local and provider-backed):
 *   - resolve log path (`opts.log ?? <ts>-gptimg.jsonl` under ctx.logDir)
 *   - open a logger that also forwards info/warn events to `opts.onProgress`
 *   - run `body(logger)`
 *   - on throw, best-effort `safeLogError`, then rethrow
 *   - always close
 *
 * The body is responsible for putting `logger.handle.path` (or the resolved
 * log path) into the result it returns; this helper does not mutate the
 * result.
 */
export async function withVerbLogger<T>(
  ctx: { logDir: string },
  verbName: LogVerb,
  opts: VerbLoggerOptions,
  body: (logger: Logger) => Promise<T>,
): Promise<T> {
  const logPath = opts.log ?? defaultLogPath(ctx.logDir, opts.ts ?? utcTimestamp());
  const logger = await createLogger(logPath, verbName, { onEvent: opts.onProgress });
  try {
    return await body(logger);
  } catch (err) {
    await safeLogError(logger, (err as Error).message, {
      code: (err as { code?: string }).code ?? null,
    });
    throw err;
  } finally {
    await logger.close();
  }
}
