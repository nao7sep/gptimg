import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecipeError } from "../../src/errors.js";
import { loadRecipe } from "../../src/recipe/load.js";

describe("loadRecipe", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-recipe-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns an empty recipe when the file is missing", async () => {
    await expect(loadRecipe(path.join(tmp, "missing.json"))).resolves.toEqual({});
  });

  it("loads and validates a recipe from disk", async () => {
    const file = path.join(tmp, "recipe.json");
    await writeFile(
      file,
      JSON.stringify({
        generate: { size: "1024x1024", n: 2 },
        vision: { shrink: { width: 512, height: 512 } },
        chroma: { color: "#00ff00" },
      }) + "\n",
    );

    await expect(loadRecipe(file)).resolves.toEqual({
      generate: { size: "1024x1024", n: 2 },
      vision: { shrink: { width: 512, height: 512 } },
      chroma: { color: "#00ff00" },
    });
  });

  it("rejects invalid JSON", async () => {
    const file = path.join(tmp, "bad.json");
    await writeFile(file, "{bad json");

    await expect(loadRecipe(file)).rejects.toBeInstanceOf(RecipeError);
    await expect(loadRecipe(file)).rejects.toMatchObject({
      code: "recipe.invalidJson",
    });
  });

  it("rejects malformed recipe sections", async () => {
    for (const [name, value] of [
      ["generate-n", { generate: { n: 0 } }],
      ["chroma-color", { chroma: { color: "green" } }],
      ["edit", { edit: { size: 123 } }],
      ["vision-shrink", { vision: { shrink: { width: 0, height: 100 } } }],
      ["network", { network: { imageGenerate: { timeout: "slow" } } }],
    ]) {
      const file = path.join(tmp, `${name}.json`);
      await writeFile(file, JSON.stringify(value));
      await expect(loadRecipe(file), name).rejects.toMatchObject({
        code: "recipe.validationFailed",
      });
    }
  });
});
