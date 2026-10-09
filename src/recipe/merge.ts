import { createDefu } from "defu";
import type { Recipe } from "../types.js";

// "Last wins" for lists too: plain defu would join an override's list onto the
// recipe's (`retryIntervals: [1]` over `[2, 3]` giving `[1, 2, 3]`).
const overrideDefu = createDefu((target, key, value) => {
  if (!Array.isArray(value)) return false;
  (target as Record<PropertyKey, unknown>)[key] = value;
  return true;
});

/**
 * Deep-merge recipes. Later arguments win over earlier ones (the standard
 * "last wins" override semantics), and a list replaces the earlier list whole.
 * The base is supplied first; each patch overrides what came before.
 */
export function mergeRecipes(base: Recipe, ...patches: Partial<Recipe>[]): Recipe {
  let result: Recipe = base;
  for (const patch of patches) {
    if (!patch) continue;
    result = overrideDefu(patch, result) as Recipe;
  }
  return result;
}
