import { statSync } from "node:fs";
import path from "node:path";
import { callModelsDir, callPolicy, type SdkContext } from "../context.ts";
import { cancelledError, fsError, GptImgError, throwIfAborted } from "../errors.ts";
import { CALL_OPTION_NAMES, withVerbLogger } from "../internal/local-verb.ts";
import { ensureModel, fileSha256, inspectCachedModel } from "../local/models/fetch.ts";
import { MODELS, type ModelKey } from "../local/models/registry.ts";
import { releaseSessions } from "../local/models/session.ts";
import { resolveNetworkForCall } from "../network/index.ts";
import type { RefusedResult } from "../refusal.ts";
import type {
  InstalledModel,
  ModelInstallFailure,
  ModelInstallResult,
  ModelIntegrity,
  ModelListResult,
  ModelReleaseResult,
  ModelVerifyEntry,
  ModelVerifyResult,
  Policy,
} from "../types.ts";
import type { VerbCallOptions } from "./options.ts";
import { validateModelKey } from "./schemas.ts";

export interface ModelInstallAllArgs {
  /** Re-download and replace even if the model is already installed. */
  force?: boolean;
  /** The models folder (absolute); default the instance's. */
  modelsDir?: string;
  /** Network policy for the download (`network.modelDownload`). */
  policy?: Policy;
}

export interface ModelInstallArgs extends ModelInstallAllArgs {
  /** The model to install. */
  key: ModelKey;
}

export interface ModelListArgs {
  /** The models folder (absolute); default the instance's. */
  modelsDir?: string;
}

export type ModelVerifyArgs = ModelListArgs;

/** `model.release` takes no arguments; the object is there so every verb has the same shape. */
export type ModelReleaseArgs = Record<string, never>;

/** Model verbs never refuse; the envelope's refused branch cannot occur. */
function completed<T>(result: T | RefusedResult): T {
  if ((result as { status?: unknown }).status === "refused") {
    throw new GptImgError("internal.invariant", "A model operation returned a refusal.");
  }
  return result as T;
}

/** A model operation's arguments, refusing any it does not take, as every verb does. */
function checkArgs<T extends object>(operation: string, args: T, known: readonly string[]): T {
  if (typeof args !== "object" || args === null) {
    throw new GptImgError("args.invalid", `${operation}: args must be an object.`, { details: { field: "args", constraint: "object" } });
  }
  const given = args as Record<string, unknown>;
  const unknown = Object.keys(given).find((key) => given[key] !== undefined && !known.includes(key));
  if (unknown !== undefined) {
    const callOption = CALL_OPTION_NAMES.includes(unknown);
    const hint = callOption ? `${unknown} is a call option and goes in the second argument` : `it takes ${known.join(", ")}`;
    throw new GptImgError("args.invalid", `${operation}: ${unknown} is not accepted; ${hint}.`, {
      details: { field: unknown, constraint: callOption ? "call option" : "known argument" },
    });
  }
  return args;
}

/**
 * Install models explicitly: the only way a model reaches its folder
 * (sdk-conventions, *Nothing installs implicitly*). Each download is staged,
 * size- and SHA-256-verified and published whole. Files from earlier pins remain
 * untouched.
 */
export async function installModelsImpl(
  ctx: SdkContext,
  keys: readonly ModelKey[],
  args: ModelInstallAllArgs,
  opts: VerbCallOptions = {},
  batch = false,
): Promise<ModelInstallResult> {
  for (const key of keys) validateModelKey(key);
  if (args.force !== undefined && typeof args.force !== "boolean") {
    throw new GptImgError("args.invalid", "model install: force must be a boolean.", {
      details: { field: "force", constraint: "boolean" },
    });
  }
  const modelsDir = callModelsDir(ctx, args.modelsDir);
  const budget = resolveNetworkForCall(callPolicy(ctx, args.policy)).modelDownload;
  return completed(await withVerbLogger(ctx, "model", opts, async (logger) => {
    const installed: InstalledModel[] = [];
    const failures: ModelInstallFailure[] = [];
    for (const key of keys) {
      // Models installed before a cancellation stay installed.
      if (opts.signal?.aborted) throw cancelledError(opts.signal.reason, installed.length > 0 ? "unknown" : "none");
      const entry = MODELS[key];
      try {
        const installedPath = await ensureModel(entry, modelsDir, {
          force: args.force,
          budget,
          signal: opts.signal,
          logger,
        });
        installed.push({ key, name: entry.name, path: installedPath, forced: args.force ?? false });
      } catch (err) {
        // A batch reports each model's outcome; a cancellation still ends it, as does a single install's failure.
        if (!batch || !(err instanceof GptImgError) || err.code === "cancelled") throw err;
        failures.push({ key, name: entry.name, code: err.code, effect: err.effect, message: err.message });
      }
    }
    return { status: "completed" as const, installed, failures };
  }));
}

/** Install one model; `args.key` names it. */
export async function installModelImpl(ctx: SdkContext, args: ModelInstallArgs, opts: VerbCallOptions = {}): Promise<ModelInstallResult> {
  const { key, ...rest } = checkArgs("model install", args, ["key", "force", "modelsDir", "policy"]);
  return installModelsImpl(ctx, [key], rest, opts);
}

/** Install every model the SDK uses. */
export async function installAllModelsImpl(ctx: SdkContext, args: ModelInstallAllArgs = {}, opts: VerbCallOptions = {}): Promise<ModelInstallResult> {
  return installModelsImpl(ctx, Object.keys(MODELS) as ModelKey[], checkArgs("model installAll", args, ["force", "modelsDir", "policy"]), opts, true);
}

export async function listModelsImpl(ctx: SdkContext, args: ModelListArgs = {}, opts: VerbCallOptions = {}): Promise<ModelListResult> {
  checkArgs("model list", args, ["modelsDir"]);
  const modelsDir = callModelsDir(ctx, args.modelsDir);
  return completed(await withVerbLogger(ctx, "model", opts, async () => {
    throwIfAborted(opts.signal);
    // A path below a file is ENOTDIR on macOS and Linux but ENOENT on Windows, which would read as nothing installed.
    assertFolderOrMissing(modelsDir);
    const models = (Object.keys(MODELS) as ModelKey[]).map((key) => {
      const entry = MODELS[key];
      const filePath = path.join(modelsDir, entry.name);
      const cache = inspectCachedModel(filePath, entry.byteSize);
      return {
        key,
        name: entry.name,
        path: filePath,
        cached: cache.usable,
        sizeBytes: cache.sizeBytes,
        downloadBytes: entry.byteSize,
      };
    });
    return { status: "completed" as const, models };
  }));
}

/**
 * Free the loaded models' memory once any inference in flight finishes. Loaded models are
 * shared by every instance in the process; the next call that needs one loads it again.
 */
export async function releaseModelsImpl(ctx: SdkContext, args: ModelReleaseArgs = {}, opts: VerbCallOptions = {}): Promise<ModelReleaseResult> {
  checkArgs("model release", args, []);
  return completed(await withVerbLogger(ctx, "model", opts, async () => {
    throwIfAborted(opts.signal);
    return { status: "completed" as const, released: await releaseSessions() };
  }));
}

/**
 * Re-hash every installed model against its pinned sha256 — the integrity check
 * installation cannot give on later runs. Using a model does not re-hash it, so
 * a model corrupted or swapped after download is otherwise used unverified;
 * this is the explicit, on-demand check. Kept separate from `list` (a cheap
 * presence check): hashing a model of hundreds of megabytes is slow, so it runs only when asked.
 */
export async function verifyModelsImpl(
  ctx: SdkContext,
  args: ModelVerifyArgs = {},
  opts: VerbCallOptions = {},
): Promise<ModelVerifyResult> {
  checkArgs("model verify", args, ["modelsDir"]);
  const modelsDir = callModelsDir(ctx, args.modelsDir);
  return completed(await withVerbLogger(ctx, "model", opts, async (logger) => {
    const models: ModelVerifyEntry[] = [];
    for (const key of Object.keys(MODELS) as ModelKey[]) {
      throwIfAborted(opts.signal);
      const entry = MODELS[key];
      const filePath = path.join(modelsDir, entry.name);
      let integrity: ModelIntegrity;
      let actualSha256: string | undefined;
      const cache = inspectCachedModel(filePath, entry.byteSize);
      if (!cache.present) {
        integrity = "missing";
      } else {
        logger.emit("info", "resolve", { event: "model.verify.start", key, name: entry.name, sizeBytes: cache.sizeBytes ?? null });
        actualSha256 = await fileSha256(filePath, opts.signal, (done) =>
          logger.progress("hash", done, cache.sizeBytes ?? done, "bytes", entry.name),
        );
        integrity = actualSha256 === entry.sha256 ? "ok" : "mismatch";
      }
      models.push({
        key,
        name: entry.name,
        path: filePath,
        integrity,
        expectedSha256: entry.sha256,
        actualSha256,
      });
      logger.emit("info", "response", { event: "model.verify.done", key, name: entry.name, integrity });
    }
    return { status: "completed" as const, models };
  }));
}

function assertFolderOrMissing(dir: string): void {
  let stats;
  try {
    stats = statSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw fsError(err, "Failed to inspect the models folder", dir);
  }
  if (!stats.isDirectory()) {
    throw fsError(Object.assign(new Error("not a directory"), { code: "ENOTDIR" }), "Failed to inspect the models folder", dir);
  }
}
