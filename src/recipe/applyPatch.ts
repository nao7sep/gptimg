import { RecipeError } from "../errors.js";
import type { Recipe } from "../types.js";
import { mergeRecipes } from "./merge.js";

/**
 * Deep-merge a JSON object (provided as a string) into the recipe.
 * The patch wins on overlapping keys (standard "last wins").
 */
export function applyPatch(recipe: Recipe, json: string): Recipe {
  let patch: unknown;
  try {
    patch = JSON.parse(json);
  } catch (err) {
    throw new RecipeError("patch.invalidJson", "Invalid JSON in --patch", {
      cause: err,
    });
  }
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new RecipeError(
      "patch.invalidJson",
      "--patch must be a JSON object",
    );
  }
  return mergeRecipes(recipe, patch as Partial<Recipe>);
}
