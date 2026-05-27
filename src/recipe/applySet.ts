import { readFile } from "node:fs/promises";
import { dset } from "dset";
import { RecipeError } from "../errors.js";
import type { Recipe, RecipeVerb } from "../types.js";

function parseScalar(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function parseSetValue(raw: string): Promise<unknown> {
  if (raw.startsWith("@")) {
    const filePath = raw.slice(1);
    let text: string;
    try {
      text = await readFile(filePath, "utf-8");
    } catch (err) {
      throw new RecipeError(
        "set.invalidExpression",
        `--set value @${filePath} could not be read: ${(err as Error).message}`,
        { cause: err },
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      // Non-JSON file: use as raw string.
      return text;
    }
  }
  return parseScalar(raw);
}

function cloneRecipe(recipe: Recipe): Recipe {
  return JSON.parse(JSON.stringify(recipe ?? {})) as Recipe;
}

const TOP_LEVEL_KEYS = new Set(["generate", "edit", "vision", "network"]);

/**
 * Apply `--set key=value` expressions to a recipe section.
 *
 * Each expression has the form `dot.path=value`. Numeric path segments
 * index arrays. Values are JSON-parsed when valid (numbers, bools, null,
 * JSON arrays/objects, etc.); otherwise treated as strings. A value of
 * `@path` reads the value from a file (parsed as JSON if possible).
 *
 * Paths that start with a recognized top-level key (`generate`, `edit`,
 * `vision`, `network`) are treated as recipe-rooted; everything else is
 * scoped under the verb's section. So `--set network.imageGenerate.timeout=...`
 * sets `recipe.network.imageGenerate.timeout`, while `--set size=...` sets
 * `recipe.<verb>.size`.
 */
export async function applySet(
  recipe: Recipe,
  verb: RecipeVerb,
  expressions: string[],
): Promise<Recipe> {
  if (expressions.length === 0) return recipe;
  const out = cloneRecipe(recipe);
  const outRecord = out as Record<string, unknown>;
  for (const expr of expressions) {
    const eq = expr.indexOf("=");
    if (eq < 0) {
      throw new RecipeError(
        "set.invalidExpression",
        `--set expression must contain "=": ${expr}`,
      );
    }
    const dotPath = expr.slice(0, eq);
    if (dotPath.length === 0) {
      throw new RecipeError(
        "set.invalidExpression",
        `--set expression has empty key: ${expr}`,
      );
    }
    const rawValue = expr.slice(eq + 1);
    const value = await parseSetValue(rawValue);
    const firstSegment = dotPath.split(".", 1)[0];
    if (firstSegment && TOP_LEVEL_KEYS.has(firstSegment)) {
      dset(outRecord, dotPath, value);
    } else {
      const section = (outRecord[verb] ??= {}) as Record<string, unknown>;
      dset(section, dotPath, value);
    }
  }
  return out;
}
