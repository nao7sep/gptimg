import { readFile } from "node:fs/promises";
import { RecipeError } from "../errors.js";
import type { Recipe } from "../types.js";
import { validateRecipe } from "./schemas.js";

export async function loadRecipe(filePath: string): Promise<Recipe> {
  let text: string;
  try {
    text = await readFile(filePath, "utf-8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      // Missing recipe is non-fatal: behave as empty.
      return {};
    }
    throw new RecipeError(
      "recipe.notFound",
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
