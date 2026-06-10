import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { withVerbLogger } from "../internal/local-verb.js";
import { defaultModelsDir } from "../internal/paths.js";
import { ensureModel } from "../local/models/fetch.js";
import { MODELS, type ModelKey } from "../local/models/registry.js";
import { resolveNetworkForCall } from "../network/index.js";
import { loadRecipeForCall } from "../recipe/load.js";
import type { ModelInstallResult, ModelListEntry } from "../types.js";
import type { VerbCallOptions } from "./options.js";
import { validateModelKey } from "./schemas.js";

interface ModelContext {
  profileDir: string;
  logDir: string;
}

export interface ModelInstallOptions extends VerbCallOptions {
  /** Re-download and replace even if the model is already cached. */
  force?: boolean;
  recipe?: string;
  /** Path to log JSONL file. Defaults to a per-session
   * `yyyymmdd-hhmmss-fff-utc.log` under the log dir. */
  log?: string;
}

export async function installModelImpl(
  ctx: ModelContext,
  key: ModelKey,
  opts: ModelInstallOptions = {},
): Promise<ModelInstallResult> {
  validateModelKey(key);
  const entry = MODELS[key];
  const budget = resolveNetworkForCall(
    await loadRecipeForCall(opts.recipe, ctx.profileDir),
  ).modelDownload;
  const cacheDir = defaultModelsDir(ctx.profileDir);
  return withVerbLogger(ctx, "model", { log: opts.log, onProgress: opts.onProgress }, async (logger) => {
    const installedPath = await ensureModel(entry, cacheDir, {
      force: opts.force,
      budget,
      signal: opts.signal,
      logger,
    });
    return { key, name: entry.name, path: installedPath, forced: opts.force ?? false };
  });
}

export async function installAllModelsImpl(
  ctx: ModelContext,
  opts: ModelInstallOptions = {},
): Promise<ModelInstallResult[]> {
  const results: ModelInstallResult[] = [];
  for (const key of Object.keys(MODELS) as ModelKey[]) {
    results.push(await installModelImpl(ctx, key, opts));
  }
  return results;
}

export function listModelsImpl(ctx: ModelContext): ModelListEntry[] {
  const cacheDir = defaultModelsDir(ctx.profileDir);
  return (Object.keys(MODELS) as ModelKey[]).map((key) => {
    const entry = MODELS[key];
    const filePath = path.join(cacheDir, entry.name);
    const cached = existsSync(filePath);
    return {
      key,
      name: entry.name,
      path: filePath,
      cached,
      sizeBytes: cached ? statSync(filePath).size : undefined,
    };
  });
}
