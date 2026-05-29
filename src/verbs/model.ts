import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { LocalOpError } from "../errors.js";
import { defaultModelsDir, defaultRecipePath } from "../internal/paths.js";
import { ensureModel } from "../local/models/fetch.js";
import { MODELS, type ModelKey } from "../local/models/registry.js";
import { resolveNetworkForCall } from "../network/index.js";
import { loadRecipe } from "../recipe/load.js";
import type { ModelInstallResult, ModelListEntry } from "../types.js";
import type { VerbCallOptions } from "./options.js";

interface ModelContext {
  profileDir: string;
}

export interface ModelInstallOptions extends VerbCallOptions {
  /** Re-download and replace even if the model is already cached. */
  force?: boolean;
  recipe?: string;
}

export async function installModelImpl(
  ctx: ModelContext,
  key: ModelKey,
  opts: ModelInstallOptions = {},
): Promise<ModelInstallResult> {
  const entry = MODELS[key];
  if (!entry) {
    throw new LocalOpError(
      "model.unknown",
      `Unknown model "${key}". Known models: ${Object.keys(MODELS).join(", ")}.`,
    );
  }
  const recipePath = opts.recipe ?? defaultRecipePath(ctx.profileDir);
  const budget = resolveNetworkForCall(await loadRecipe(recipePath)).modelDownload;
  const cacheDir = defaultModelsDir(ctx.profileDir);
  const installedPath = await ensureModel(entry, cacheDir, {
    force: opts.force,
    budget,
    signal: opts.signal,
  });
  return { key, name: entry.name, path: installedPath, forced: opts.force ?? false };
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
