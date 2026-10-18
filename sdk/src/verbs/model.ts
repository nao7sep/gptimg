import path from "node:path";
import { callModelsDir, callPolicy, type SdkContext } from "../context.ts";
import { GptImgError, throwIfAborted } from "../errors.ts";
import { withVerbLogger } from "../internal/local-verb.ts";
import { ensureModel, fileSha256, inspectCachedModel } from "../local/models/fetch.ts";
import { MODELS, type ModelKey } from "../local/models/registry.ts";
import { resolveNetworkForCall } from "../network/index.ts";
import type { RefusedResult } from "../refusal.ts";
import type {
  InstalledModel,
  ModelInstallResult,
  ModelIntegrity,
  ModelListResult,
  ModelVerifyEntry,
  ModelVerifyResult,
  Policy,
} from "../types.ts";
import type { VerbCallOptions } from "./options.ts";
import { validateModelKey } from "./schemas.ts";

export interface ModelInstallOptions extends VerbCallOptions {
  /** Re-download and replace even if the model is already installed. */
  force?: boolean;
  /** The models folder (absolute); default the instance's. */
  modelsDir?: string;
  /** Network policy for the download (`network.modelDownload`). */
  policy?: Policy;
}

export interface ModelVerifyOptions extends VerbCallOptions {
  /** The models folder (absolute); default the instance's. */
  modelsDir?: string;
}

/** Model verbs never refuse; the envelope's refused branch cannot occur. */
function completed<T>(result: T | RefusedResult): T {
  if ((result as { status?: unknown }).status === "refused") {
    throw new GptImgError("internal.invariant", "A model operation returned a refusal.");
  }
  return result as T;
}

/**
 * Install models explicitly: the only way a model reaches its folder
 * (sdk-conventions, *Nothing installs implicitly*). Each download is staged,
 * size- and SHA-256-verified and published whole; a superseded pin's file is
 * deleted once its replacement is verified.
 */
export async function installModelsImpl(
  ctx: SdkContext,
  keys: readonly ModelKey[],
  opts: ModelInstallOptions = {},
): Promise<ModelInstallResult> {
  for (const key of keys) validateModelKey(key);
  if (opts.force !== undefined && typeof opts.force !== "boolean") {
    throw new GptImgError("args.invalid", "model install: force must be a boolean.", {
      details: { field: "force", constraint: "boolean" },
    });
  }
  const modelsDir = callModelsDir(ctx, opts.modelsDir);
  const budget = resolveNetworkForCall(callPolicy(ctx, opts.policy)).modelDownload;
  return completed(await withVerbLogger(ctx, "model", opts, async (logger) => {
    const installed: InstalledModel[] = [];
    for (const key of keys) {
      throwIfAborted(opts.signal);
      const entry = MODELS[key];
      const installedPath = await ensureModel(entry, modelsDir, {
        force: opts.force,
        budget,
        signal: opts.signal,
        logger,
      });
      installed.push({ key, name: entry.name, path: installedPath, forced: opts.force ?? false });
    }
    return { status: "completed" as const, installed, logPath: logger.handle.path };
  }));
}

export function listModelsImpl(ctx: SdkContext, opts: { modelsDir?: string } = {}): ModelListResult {
  const modelsDir = callModelsDir(ctx, opts.modelsDir);
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
      downloadBytes: entry.byteSize ?? null,
    };
  });
  return { status: "completed", models };
}

/**
 * Re-hash every installed model against its pinned sha256 — the integrity check
 * installation cannot give on later runs. Using a model does not re-hash it, so
 * a model corrupted or swapped after download is otherwise used unverified;
 * this is the explicit, on-demand check. Kept separate from `list` (a cheap
 * presence check): hashing a ~0.5 GB model is slow, so it runs only when asked.
 */
export async function verifyModelsImpl(
  ctx: SdkContext,
  opts: ModelVerifyOptions = {},
): Promise<ModelVerifyResult> {
  const modelsDir = callModelsDir(ctx, opts.modelsDir);
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
      } else if (!entry.sha256) {
        integrity = "unverifiable";
      } else {
        await logger.info("resolve", "verifying installed model", {
          key,
          name: entry.name,
          sizeBytes: cache.sizeBytes ?? null,
        });
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
      await logger.info("response", "model verification result", { key, name: entry.name, integrity });
    }
    return { status: "completed" as const, models, logPath: logger.handle.path };
  }));
}
