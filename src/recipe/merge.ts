import { defu } from "defu";
import type { Recipe } from "../types.js";

/**
 * Deep-merge recipes. Later arguments win over earlier ones (the standard
 * "last wins" override semantics). The base is supplied first; each patch
 * overrides what came before.
 */
export function mergeRecipes(base: Recipe, ...patches: Partial<Recipe>[]): Recipe {
  let result: Recipe = base;
  for (const patch of patches) {
    if (!patch) continue;
    result = defu(patch, result) as Recipe;
  }
  return result;
}
