import { readFile } from "node:fs/promises";
import { RecipeError } from "../errors.js";
import { defaultRecipePath } from "../internal/paths.js";
import type { Recipe } from "../types.js";
import { validateRecipe } from "./schemas.js";

/**
 * Load and validate a recipe from `filePath`.
 *
 * A caller that names a recipe file owns its existence: by default a missing
 * file is a usage error (`recipe.notFound`). Pass `required: false` for the
 * optional default recipe, where an absent file is the normal "no recipe
 * configured" case and yields an empty recipe. A non-ENOENT read failure
 * (permissions, the path is a directory) is the environment's fault and surfaces
 * as the runtime error `recipe.readFailed`.
 */
export async function loadRecipe(
  filePath: string,
  opts: { required?: boolean } = {},
): Promise<Recipe> {
  const required = opts.required ?? true;
  let text: string;
  try {
    text = await readFile(filePath, "utf-8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      if (!required) return {};
      throw new RecipeError(
        "recipe.notFound",
        `Recipe file not found: ${filePath}`,
        { cause: err },
      );
    }
    throw new RecipeError(
      "recipe.readFailed",
      `Failed to read recipe at ${filePath}: ${e.message}`,
      { cause: err },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new RecipeError(
      "recipe.invalidJson",
      `Invalid JSON in recipe at ${filePath}`,
      { cause: err },
    );
  }
  return validateRecipe(parsed);
}

/**
 * Resolve the recipe for a verb call. The single seam every verb routes
 * through: an explicitly named recipe must exist; the default recipe path is
 * optional and absent by default.
 */
export async function loadRecipeForCall(
  recipeArg: string | undefined,
  profileDir: string,
): Promise<Recipe> {
  if (recipeArg !== undefined) {
    return loadRecipe(recipeArg, { required: true });
  }
  return loadRecipe(defaultRecipePath(profileDir), { required: false });
}
