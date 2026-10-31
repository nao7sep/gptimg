/**
 * Shared building blocks for verbs. `withVerbLogger` is the single logger
 * envelope used by every verb — the local single-file ops (mask, compose,
 * trim, backplate, layer, …) and the provider-backed ones (generate, edit,
 * vision) and model install alike. The output-path helpers below are for the
 * local single-file ops; generate/edit have richer per-image-sidecar/output-
 * group orchestration in `output-group.ts`.
 */

import path from "node:path";
import { readdir } from "node:fs/promises";
import { cancelledError, GptImgError, fsError } from "../errors.ts";
import { assertAbsolutePath } from "./absolute-path.ts";
import { createLogger, type Logger } from "../events/index.ts";
import type { SdkContext } from "../context.ts";
import { VERSION } from "../version.ts";
import { diagnosticOf } from "../events/diagnostic.ts";
import { RefusalSignal, refuse, type RefusedResult } from "../refusal.ts";
import { responseIdOf, usageOf } from "../usage.ts";
import { NO_LOG_HINT, type VerbCallOptions } from "../verbs/options.ts";
import { ensureOutputDir } from "./output-files.ts";
import { refuseCaseOnlyRename } from "./output-group.ts";
import { containOutOfMemory } from "./out-of-memory.ts";
import { imageFileName } from "./output-naming.ts";
import type { EncodingArgs, PngEncodingArgs, VerbName } from "../types.ts";
import { ENCODING_DEFAULTS } from "../defaults.ts";

/** Stem (basename without extension) of a file path. `foo/bar.png` → `bar`. */
export function inferStem(filePath: string): string {
  const base = path.basename(filePath);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Refuse to overwrite a single existing file unless explicitly allowed, and
 * refuse even then to replace a file whose name differs only in case
 * (`refuseCaseOnlyRename`). A Unicode spelling change must identify the same
 * directory entry. This is the fail-fast check before a verb does its work;
 * the no-clobber publication in `image/bridge.ts` stays the authority
 * when another writer creates the file in the meantime. The group-scoped
 * variant (`assertOutputGroupAvailable` / `assertStemAvailable` in
 * output-group.ts) is for generate/edit's multi-file artifact groups.
 */
export async function assertSingleFileAvailable(
  filePath: string,
  allowOverwrite: boolean,
): Promise<void> {
  // Compare case-folded NFC: case variants and canonical Unicode spellings
  // collide on standard macOS/Windows volumes. Keep discovered names for I/O.
  const dir = path.dirname(filePath);
  const target = path.basename(filePath).normalize("NFC").toLowerCase();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    // A missing directory means nothing to collide with; other errors surface.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw fsError(err, "Failed to scan output directory", dir);
  }
  const clashes = entries.filter((name) => name.normalize("NFC").toLowerCase() === target);
  if (allowOverwrite) {
    for (const clash of clashes) await refuseCaseOnlyRename(path.join(dir, clash), filePath, entries);
  } else if (clashes.length > 0) {
    const existing = path.join(dir, clashes[0]!);
    refuse("output.exists", `Output exists: ${existing}. Set overwrite: true to allow.`, { subject: existing });
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
 * A no-input verb requires a caller-selected destination. An absolute outName
 * already supplies that destination; no app-root or implicit cwd fallback exists.
 *
 * `outName` is a bare STEM, or an absolute stem that also chooses the folder;
 * a relative stem with folders is an invalid call, since the SDK reads no
 * working directory. It is not a filename: the verb owns its extension, which is
 * appended here via the same primitive `generate` uses (`imageFileName`).
 * This is strict — a stem that already carries an extension yields
 * `<stem>.<ext>.<ext>` (mirroring `generate`, surfacing the misuse instead of
 * silently swallowing it). `outName` falls back to `defaults.stem`; an
 * absolute stem overrides outDir entirely.
 */
export async function resolveOutputPath(
  args: { outDir?: string | undefined; outName?: string | undefined; out?: string | undefined },
  defaults: {
    inputForDir?: string | undefined;
    stem: string;
    ext: string;
  },
): Promise<string> {
  if (args.out !== undefined) {
    const output = exactOutputPath(args, defaults.ext);
    await ensureOutputDir(path.dirname(output));
    return output;
  }
  const stem = args.outName ?? defaults.stem;
  assertOutputStem(stem);
  const fileName = imageFileName(stem, 1, 1, defaults.ext);
  const outDir = args.outDir ??
    (defaults.inputForDir !== undefined ? path.dirname(defaults.inputForDir) : undefined);
  if (!path.isAbsolute(fileName) && outDir === undefined) {
    throw new GptImgError("args.invalid", "Set outDir to choose an output directory.", {
      details: { field: "outDir", constraint: "required" },
    });
  }
  const output = path.isAbsolute(fileName) ? fileName : path.join(outDir!, fileName);
  await ensureOutputDir(path.dirname(output));
  return output;
}

/**
 * The exact output file a caller named with `out`: absolute, not combined with
 * the folder-and-stem form, and carrying the extension of the format the verb
 * writes (either spelling of JPEG's), so a file is never named as another format.
 */
function exactOutputPath(args: { outDir?: string | undefined; outName?: string | undefined; out?: string | undefined }, ext: string): string {
  const out = args.out!;
  assertAbsolutePath(out, "out");
  if (args.outDir !== undefined || args.outName !== undefined) {
    throw new GptImgError("args.invalid", "out names the exact output file; leave out outDir and outName.", {
      details: { field: "out", constraint: "not with outDir or outName" },
    });
  }
  const given = path.extname(out).slice(1).toLowerCase();
  const accepted = ext === "jpg" || ext === "jpeg" ? ["jpg", "jpeg"] : [ext];
  if (!accepted.includes(given)) {
    throw new GptImgError("args.invalid", `out must end in .${ext} for the format written; got ${JSON.stringify(path.basename(out))}.`, {
      subject: out,
      details: { field: "out", constraint: `.${accepted.join(" or .")} extension` },
    });
  }
  return out;
}

/**
 * An output name is a bare stem or an absolute stem: a relative stem with
 * folders would need the working directory to resolve.
 */
export function assertOutputStem(stem: string, field = "outName"): void {
  if (path.isAbsolute(stem)) return;
  if (stem.length === 0 || stem.includes("/") || stem.includes("\\") || stem === "." || stem === "..") {
    throw new GptImgError("args.invalid", `${field} must be a bare name or an absolute stem; got ${JSON.stringify(stem)}.`, {
      details: { field, constraint: "bare name or absolute stem" },
    });
  }
}

/**
 * The folder and bare stem a group of outputs lands under: a bare `outName`
 * goes in `outDir`, and an absolute one also chooses the folder, as it does
 * for the local verbs.
 */
export function outputStemLocation(outDir: string | undefined, outName: string): { outDir: string; stem: string } {
  assertOutputStem(outName);
  if (path.isAbsolute(outName)) return { outDir: path.dirname(outName), stem: path.basename(outName) };
  if (outDir === undefined) {
    throw new GptImgError("args.invalid", "Set outDir to choose an output directory, or use an absolute outName.", {
      details: { field: "outDir", constraint: "required" },
    });
  }
  return { outDir, stem: outName };
}

// The call options, the same for every verb: a verb with nothing to send through a hook never
// calls it. An unknown one is refused, as an unknown argument is.
// Typed by VerbCallOptions, so the list cannot miss or invent one.
const CALL_OPTIONS: Record<keyof VerbCallOptions, true> = { signal: true, onEvent: true, onProgress: true, onPartialImage: true };
export const CALL_OPTION_NAMES: readonly string[] = Object.keys(CALL_OPTIONS);

/**
 * The single envelope for every verb:
 *   - check the call options, and open the verb's event sink: every event to
 *     `onEvent`, countable work to `onProgress`, debug events only when the
 *     instance asked for them;
 *   - hand the instance's startup event to the first call that listens;
 *   - run `body(logger)`;
 *   - turn a refusal signal into `{ status: "refused" }`, an allocation failure
 *     into `memory.exhausted`, and any failure that escaped classification into
 *     `internal.unexpected`, so everything that leaves the SDK is a
 *     `GptImgError` or a result, each reported as the call's last event.
 */
export async function withVerbLogger<T>(
  ctx: SdkContext,
  verbName: VerbName,
  opts: VerbCallOptions,
  body: (logger: Logger) => Promise<T>,
): Promise<T | RefusedResult> {
  const known: readonly string[] = CALL_OPTION_NAMES;
  const unknown = Object.keys(opts ?? {}).find((key) => (opts as Record<string, unknown>)[key] !== undefined && !known.includes(key));
  if (unknown !== undefined) {
    const hint = unknown === "log" ? NO_LOG_HINT : `the call options are ${known.join(", ")}`;
    throw new GptImgError("args.invalid", `${verbName}: ${unknown} is not a call option; ${hint}.`, {
      details: { field: unknown, constraint: unknown === "log" ? "retired" : "known call option" },
    });
  }
  // A caller's types are not a contract: a wrong kind of option fails here, not deep inside the work.
  if (opts.signal !== undefined && !(opts.signal instanceof AbortSignal)) {
    throw new GptImgError("args.invalid", `${verbName}: signal must be an AbortSignal.`, { details: { field: "signal", constraint: "AbortSignal" } });
  }
  for (const hook of ["onEvent", "onProgress", "onPartialImage"] as const) {
    if (opts[hook] !== undefined && typeof opts[hook] !== "function") {
      throw new GptImgError("args.invalid", `${verbName}: ${hook} must be a function.`, { details: { field: hook, constraint: "function" } });
    }
  }
  const logger = createLogger(verbName, { onEvent: opts.onEvent, onProgress: opts.onProgress, debug: ctx.debug });
  // The instance's key is masked from the call's first event, before any provider registers it.
  if (ctx.apiKey) logger.addCredential(ctx.apiKey);
  if (opts.onEvent && !ctx.startup.emitted) {
    ctx.startup.emitted = true;
    logger.emit("info", "startup", {
      event: "sdk.start",
      version: VERSION,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      modelsDir: ctx.modelsDir,
      debug: ctx.debug,
      caller: ctx.caller ?? null,
      apiKey: ctx.apiKey !== null,
      organization: ctx.organization ?? null,
      project: ctx.project ?? null,
      policy: ctx.policy,
    });
  }
  try {
    return await body(logger);
  } catch (thrown) {
    if (thrown instanceof RefusalSignal) {
      logger.emit("warn", "response", { event: "verb.refused", code: thrown.refusal.code, subject: thrown.refusal.subject ?? null });
      return {
        status: "refused",
        refusal: thrown.refusal,
        ...(thrown.response !== undefined && {
          response: thrown.response,
          usage: usageOf(thrown.response),
          responseId: responseIdOf(thrown.response),
        }),
      };
    }
    const err = toSdkError(verbName, thrown, opts.signal);
    // A cancellation is the caller's request, never a failure, so it is recorded as such.
    if (err.code === "cancelled") logger.emit("info", "error", { event: "verb.cancelled", error: err.toJSON() });
    else logger.emit("error", "error", { event: "verb.failed", error: err.toJSON(), diagnostic: diagnosticOf(err) });
    throw err;
  }
}

/**
 * Everything that leaves a verb as a failure is a `GptImgError`. Once the
 * caller's signal has fired, whatever the interrupted work threw is that
 * cancellation, keeping any effect the work had reported.
 */
function toSdkError(verbName: VerbName, thrown: unknown, signal: AbortSignal | undefined): GptImgError {
  // Icon publication defers cancellation once it starts. Its recorded paths
  // belong to the settled publication failure, even if an abort arrived meanwhile.
  if (verbName === "icon" && thrown instanceof GptImgError && thrown.details?.publishedPaths !== undefined) return thrown;
  if (signal?.aborted && !(thrown instanceof GptImgError && thrown.code === "cancelled")) {
    return cancelledError(thrown, thrown instanceof GptImgError ? thrown.effect : "unknown");
  }
  const contained = containOutOfMemory(verbName, thrown);
  if (contained instanceof GptImgError) return contained;
  return new GptImgError(
    "internal.unexpected",
    `${verbName} failed unexpectedly: ${contained instanceof Error ? contained.message : String(contained)}`,
    { cause: contained, effect: "unknown" },
  );
}
const PNG_ENCODING_KEYS = ["compressionLevel", "adaptiveFiltering"] as const;
const ENCODING_KEYS = ["format", "quality", "lossless", "smartSubsample", ...PNG_ENCODING_KEYS, "opaque", "background"] as const;

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

/** The encoding fields a verb's start event carries; an option left unset is reported as null. */
export function encodingEventFields(args: EncodingArgs): Record<string, unknown> {
  return {
    format: args.format ?? ENCODING_DEFAULTS.format,
    quality: args.quality ?? null,
    lossless: args.lossless ?? null,
    smartSubsample: args.smartSubsample ?? null,
    compressionLevel: args.compressionLevel ?? null,
    adaptiveFiltering: args.adaptiveFiltering ?? null,
    opaque: args.opaque ?? false,
    background: args.background ?? null,
  };
}

/** The same for a verb that fixes its format to PNG. */
export function pngEncodingEventFields(args: PngEncodingArgs): Record<string, unknown> {
  return {
    compressionLevel: args.compressionLevel ?? null,
    adaptiveFiltering: args.adaptiveFiltering ?? null,
  };
}
