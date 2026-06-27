import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { withVerbLogger } from "../internal/local-verb.js";
import { defaultModelsDir } from "../internal/paths.js";
import { ensureModel, fileSha256 } from "../local/models/fetch.js";
import { MODELS, type ModelKey } from "../local/models/registry.js";
import { resolveNetworkForCall } from "../network/index.js";
import { loadRecipeForCall } from "../recipe/load.js";
import type {
  InstalledModel,
  ModelInstallResult,
  ModelIntegrity,
  ModelListResult,
  ModelVerifyEntry,
  ModelVerifyResult,
} from "../types.js";
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
): Promise<InstalledModel> {
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
): Promise<ModelInstallResult> {
  const installed: InstalledModel[] = [];
  for (const key of Object.keys(MODELS) as ModelKey[]) {
    installed.push(await installModelImpl(ctx, key, opts));
  }
  return { installed };
}

export function listModelsImpl(ctx: ModelContext): ModelListResult {
  const cacheDir = defaultModelsDir(ctx.profileDir);
  const models = (Object.keys(MODELS) as ModelKey[]).map((key) => {
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
  return { models };
}

/**
 * Re-hash every cached model against its pinned sha256 — the integrity check the
 * install-time verification cannot give on later runs. A cache hit returns the
 * file without re-hashing (fetch.ts), so a model corrupted or swapped after
 * download is otherwise used unverified; this is the explicit, on-demand check
 * for that. Kept separate from `list` (a cheap presence check): hashing a ~0.5 GB
 * model is slow, so it runs only when asked, never on every load.
 */
export async function verifyModelsImpl(ctx: ModelContext): Promise<ModelVerifyResult> {
  const cacheDir = defaultModelsDir(ctx.profileDir);
  const models: ModelVerifyEntry[] = [];
  for (const key of Object.keys(MODELS) as ModelKey[]) {
    const entry = MODELS[key];
    const filePath = path.join(cacheDir, entry.name);
    let integrity: ModelIntegrity;
    let actualSha256: string | undefined;
    if (!existsSync(filePath)) {
      integrity = "missing";
    } else if (!entry.sha256) {
      integrity = "unverifiable";
    } else {
      actualSha256 = await fileSha256(filePath);
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
  }
  return { models };
}
