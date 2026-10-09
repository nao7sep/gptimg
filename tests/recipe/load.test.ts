import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecipeError } from "../../src/errors.js";
import { RECIPE_FORMAT_VERSION } from "../../src/format-versions.js";
import { loadRecipe, loadRecipeForCall } from "../../src/recipe/load.js";
import { defaultRecipePath } from "../../src/internal/paths.js";
import { validateChromaSection, validateVisionSection } from "../../src/recipe/schemas.js";

describe("loadRecipe", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-recipe-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("treats a named-but-missing recipe as a usage error", async () => {
    await expect(
      loadRecipe(path.join(tmp, "missing.json")),
    ).rejects.toMatchObject({ code: "recipe.notFound" });
  });

  it("returns an empty recipe for a missing optional (required:false) recipe", async () => {
    await expect(
      loadRecipe(path.join(tmp, "missing.json"), { required: false }),
    ).resolves.toEqual({});
  });

  it("reports a non-ENOENT read failure as a runtime error", async () => {
    // Reading a directory yields EISDIR, not ENOENT: the environment's fault,
    // so a runtime error rather than the caller-named-missing usage error.
    await expect(loadRecipe(tmp)).rejects.toMatchObject({
      code: "recipe.readFailed",
    });
  });

  it("loads and validates a recipe from disk", async () => {
    const file = path.join(tmp, "recipe.json");
    await writeFile(
      file,
      JSON.stringify({
        formatVersion: 1,
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
    const cases: [string, Record<string, unknown>][] = [
      ["generate-n", { generate: { n: 0 } }],
      ["chroma-color", { chroma: { color: "green" } }],
      ["edit", { edit: { size: 123 } }],
      ["vision-shrink", { vision: { shrink: { width: 0, height: 100 } } }],
      ["network", { network: { imageGenerate: { timeout: "slow" } } }],
    ];
    for (const [name, value] of cases) {
      const file = path.join(tmp, `${name}.json`);
      await writeFile(file, JSON.stringify({ formatVersion: 1, ...value }));
      await expect(loadRecipe(file), name).rejects.toMatchObject({
        code: "recipe.validationFailed",
      });
    }
  });
});

describe("loadRecipeForCall", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-recipe-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("fails when a caller-named recipe is missing", async () => {
    await expect(
      loadRecipeForCall(path.join(tmp, "typo.json"), tmp),
    ).rejects.toMatchObject({ code: "recipe.notFound" });
  });

  it("treats an absent default recipe as empty (no recipe configured)", async () => {
    await expect(loadRecipeForCall(undefined, tmp)).resolves.toEqual({});
  });

  it("loads the default recipe from the profile dir when present", async () => {
    await writeFile(
      defaultRecipePath(tmp),
      JSON.stringify({ formatVersion: 1, generate: { n: 3 } }) + "\n",
    );
    await expect(loadRecipeForCall(undefined, tmp)).resolves.toEqual({
      generate: { n: 3 },
    });
  });
});

describe("recipe format version", () => {
  let tmp: string;
  let file: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-recipe-format-"));
    file = path.join(tmp, "recipe.json");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("reads a v0.1.0 recipe, which has no formatVersion, as version 1 without rewriting it", async () => {
    for (const text of [JSON.stringify({ generate: { n: 2 } }), "{}"]) {
      await writeFile(file, text);
      await expect(loadRecipe(file), text).resolves.toEqual(JSON.parse(text));
      expect(await readFile(file, "utf-8")).toBe(text);
    }
  });

  it("treats a recipe that is not an object, or whose formatVersion is not a positive integer, as unreadable", async () => {
    for (const text of ["null", "[]", JSON.stringify({ formatVersion: 0 }), JSON.stringify({ formatVersion: "1" }), JSON.stringify({ formatVersion: null })]) {
      await writeFile(file, text);
      await expect(loadRecipe(file), text).rejects.toMatchObject({ code: "recipe.validationFailed" });
    }
  });

  it("leaves section checks to the verbs that use them, while recipe.load checks the whole file", async () => {
    await writeFile(
      defaultRecipePath(tmp),
      JSON.stringify({ formatVersion: RECIPE_FORMAT_VERSION, vision: { detail: "bogus" }, chroma: { color: "#00ff00" } }),
    );

    const forCall = await loadRecipeForCall(undefined, tmp);
    expect(validateChromaSection(forCall.chroma)).toEqual({ color: "#00ff00" });
    expect(() => validateVisionSection(forCall.vision)).toThrow(RecipeError);
    await expect(loadRecipe(defaultRecipePath(tmp))).rejects.toMatchObject({ code: "recipe.validationFailed" });
  });

  it("reads the current format version and returns the recipe without it", async () => {
    await writeFile(
      file,
      JSON.stringify({ formatVersion: RECIPE_FORMAT_VERSION, generate: { n: 2 } }),
    );

    await expect(loadRecipe(file)).resolves.toEqual({ generate: { n: 2 } });
  });

  it("refuses a recipe of a newer format, named or default, and leaves it byte-identical", async () => {
    const text = JSON.stringify({ formatVersion: RECIPE_FORMAT_VERSION + 1, generate: { n: "many" } });
    const defaultFile = defaultRecipePath(tmp);
    await writeFile(file, text);
    await writeFile(defaultFile, text);
    const before = await stat(file);

    for (const [name, run, target] of [
      ["named", () => loadRecipe(file), file],
      ["default", () => loadRecipeForCall(undefined, tmp), defaultFile],
    ] as const) {
      const err = await run().catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(RecipeError);
      expect(err, name).toMatchObject({ code: "recipe.newerFormat" });
      expect((err as Error).message, name).toContain(target);
      expect(await readFile(target, "utf-8"), name).toBe(text);
    }
    const after = await stat(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("rejects a formatVersion that is not a positive integer", async () => {
    for (const value of [0, -1, 2.5, "1", true]) {
      await writeFile(file, JSON.stringify({ formatVersion: value }));
      await expect(loadRecipe(file), JSON.stringify(value)).rejects.toMatchObject({
        code: "recipe.validationFailed",
      });
    }
  });
});
