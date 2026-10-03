/**
 * Shared building blocks for verbs. `withVerbLogger` is the single logger
 * envelope used by every verb — the local single-file ops (mask, compose,
 * trim, backplate, layer, …) and the provider-backed ones (generate, edit,
 * vision) and model install alike. The output-path helpers below are for the
 * local single-file ops; generate/edit have richer per-image-sidecar/output-
 * group orchestration in `output-group.ts`.
 */

import path from "node:path";
import { readdirSync } from "node:fs";
import { LocalOpError } from "../errors.js";
import { createLogger, safeLogError, type Logger } from "../log/index.js";
import { ensureOutputDir } from "./output-files.js";
import { imageFileName } from "./output-naming.js";
import { defaultLogPath, utcTimestampMs } from "./paths.js";
import type { EncodingArgs, LogEntry, LogVerb, PngEncodingArgs } from "../types.js";

/** Stem (basename without extension) of a file path. `foo/bar.png` → `bar`. */
export function inferStem(filePath: string): string {
  const base = path.basename(filePath);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Refuse to overwrite a single existing file unless explicitly allowed. This
 * is the fail-fast check before a verb does its work; the no-clobber
 * publication in `image/bridge.ts` stays the authority when another writer
 * creates the file in the meantime. The group-scoped variant (`assertOutputGroupAvailable` / `assertStemAvailable`
 * in output-group.ts) is for generate/edit's multi-file artifact groups.
 */
export function assertSingleFileAvailable(
  filePath: string,
  allowOverwrite: boolean,
): void {
  if (allowOverwrite) return;
  // Case-insensitive: on macOS/Windows filesystems a name that differs only in
  // case from `filePath` would collide, so scan the directory and compare
  // casefolded rather than a single case-sensitive existsSync.
  const dir = path.dirname(filePath);
  const target = path.basename(filePath).toLowerCase();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    // A missing directory means nothing to collide with; other errors surface.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  const clash = entries.find((name) => name.toLowerCase() === target);
  if (clash !== undefined) {
    throw new LocalOpError(
      "output.exists",
      `Output exists: ${path.join(dir, clash)}. Set overwrite: true to allow.`,
    );
  }
}

/**
 * Resolve {outDir, outName} args to a concrete absolute output path, creating
 * the directory if needed.
 *
 * The output directory is chosen in order:
 *   1. `args.outDir`, when the caller named one;
 *   2. otherwise `dirname(inputForDir)` for a verb that has an input file — the
 *      source file is a legitimate explicit base;
 *   3. otherwise `fallbackDir`, the home-anchored output directory a no-input
 *      verb (e.g. `backplate`) supplies as `defaultOutDir(profileDir)`.
 *
 * The working directory is never a base: a path the app writes is anchored to
 * the home directory or to the source file, never to how the process was
 * launched (storage-path-conventions). A verb that provides neither an input
 * file nor a fallback directory is a programmer error and throws, rather than
 * silently writing under the cwd.
 *
 * `outName` is a STEM, not a filename: the verb owns its extension, which is
 * appended here via the same primitive `generate` uses (`imageFileName`).
 * This is strict — a stem that already carries an extension yields
 * `<stem>.<ext>.<ext>` (mirroring `generate`, surfacing the misuse instead of
 * silently swallowing it). `outName` falls back to `defaults.stem`; an
 * absolute stem overrides outDir entirely.
 */
export async function resolveOutputPath(
  args: { outDir?: string | undefined; outName?: string | undefined },
  defaults: {
    inputForDir?: string | undefined;
    fallbackDir?: string | undefined;
    stem: string;
    ext: string;
  },
): Promise<string> {
  const outDir =
    args.outDir ??
    (defaults.inputForDir !== undefined
      ? path.dirname(defaults.inputForDir)
      : defaults.fallbackDir);
  if (outDir === undefined) {
    throw new LocalOpError(
      "output.noBaseDir",
      "No output directory: a verb with no input file must supply a fallback directory.",
    );
  }
  await ensureOutputDir(outDir);
  const stem = args.outName ?? defaults.stem;
  const fileName = imageFileName(stem, 1, 1, defaults.ext);
  return path.isAbsolute(fileName) ? fileName : path.join(outDir, fileName);
}

export interface VerbLoggerOptions {
  /** Explicit log path. Falls back to a per-session
   * `yyyymmdd-hhmmss-fff-utc.log` under ctx.logDir. */
  log?: string | undefined;
  /** Progress sink: each non-error stage event is forwarded here as it fires. */
  onProgress?: ((entry: LogEntry) => void) | undefined;
}

function serializeThrownError(
  err: unknown,
  seen = new Set<object>(),
  depth = 0,
): Record<string, unknown> {
  if (!(err instanceof Error)) {
    return { type: typeof err, message: String(err) };
  }
  const serialized: Record<string, unknown> = {
    type: err.constructor?.name || err.name || "Error",
    message: err.message,
  };
  if (err.stack) serialized.stack = err.stack;
  if (depth >= 4 || seen.has(err)) return serialized;
  seen.add(err);
  if (err.cause !== undefined) {
    serialized.cause = serializeThrownError(err.cause, seen, depth + 1);
  }
  return serialized;
}

/**
 * The single logger envelope for every verb (local and provider-backed):
 *   - resolve log path (`opts.log ?? <yyyymmdd-hhmmss-fff-utc>.log` under ctx.logDir)
 *   - open a logger that also forwards non-error events to `opts.onProgress`
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
  // The session log carries its own millisecond-precision name so two runs that
  // start in the same UTC second never interleave into one file. This is
  // deliberately independent of any second-precision stamp a verb uses for its
  // output names — the log filename is a per-session identity, not an output.
  const logPath = opts.log ?? defaultLogPath(ctx.logDir, utcTimestampMs());
  const logger = await createLogger(logPath, verbName, { onEvent: opts.onProgress });
  try {
    return await body(logger);
  } catch (err) {
    await safeLogError(logger, err instanceof Error ? err.message : String(err), {
      code: (err as { code?: string }).code ?? null,
      error: serializeThrownError(err),
    });
    throw err;
  } finally {
    await logger.close();
  }
}

const PNG_ENCODING_KEYS = ["compressionLevel", "adaptiveFiltering"] as const;
const ENCODING_KEYS = ["format", "quality", "lossless", "smartSubsample", ...PNG_ENCODING_KEYS, "opaque"] as const;

function pickDefined<K extends keyof EncodingArgs>(args: EncodingArgs, keys: readonly K[]): Pick<EncodingArgs, K> {
  const picked: Pick<EncodingArgs, K> = {} as Pick<EncodingArgs, K>;
  for (const key of keys) {
    if (args[key] !== undefined) picked[key] = args[key];
  }
  return picked;
}

/** The encoding options the caller set, and no others, to hand on to the encoder. */
export function encodingOf(args: EncodingArgs): EncodingArgs {
  return pickDefined(args, ENCODING_KEYS);
}

/** The lossless PNG options the caller set, and no others, for a verb that fixes its format. */
export function pngEncodingOf(args: PngEncodingArgs): PngEncodingArgs {
  return pickDefined(args, PNG_ENCODING_KEYS);
}

/** The encoding fields a verb's start log line carries; an option left unset is logged as null. */
export function encodingLogFields(args: EncodingArgs): Record<string, unknown> {
  return {
    format: args.format ?? "png",
    quality: args.quality ?? null,
    lossless: args.lossless ?? null,
    smartSubsample: args.smartSubsample ?? null,
    compressionLevel: args.compressionLevel ?? null,
    adaptiveFiltering: args.adaptiveFiltering ?? null,
    opaque: args.opaque ?? false,
  };
}

/** The same for a verb that fixes its format to PNG. */
export function pngEncodingLogFields(args: PngEncodingArgs): Record<string, unknown> {
  return {
    compressionLevel: args.compressionLevel ?? null,
    adaptiveFiltering: args.adaptiveFiltering ?? null,
  };
}
