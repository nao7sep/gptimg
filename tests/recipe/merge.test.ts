import { describe, expect, it } from "vitest";
import { RecipeError } from "../../src/errors.js";
import { applyPatch } from "../../src/recipe/applyPatch.js";
import { mergeRecipes } from "../../src/recipe/merge.js";
import type { Recipe } from "../../src/types.js";

describe("mergeRecipes", () => {
  it("returns the base unchanged when no patches are given", () => {
    const base: Recipe = { generate: { size: "1024x1024" } };
    expect(mergeRecipes(base)).toEqual(base);
  });

  it("applies a single patch, patch winning on overlap", () => {
    const base: Recipe = { generate: { size: "old", quality: "high" } };
    const patch: Partial<Recipe> = { generate: { size: "new" } };
    const out = mergeRecipes(base, patch);
    expect(out.generate?.size).toBe("new");
    expect(out.generate?.quality).toBe("high");
  });

  it("preserves last-wins ordering across multiple patches", () => {
    const base: Recipe = { generate: { size: "base", quality: "low" } };
    const p1: Partial<Recipe> = { generate: { size: "p1" } };
    const p2: Partial<Recipe> = { generate: { size: "p2", quality: "p2q" } };
    const out = mergeRecipes(base, p1, p2);
    expect(out.generate?.size).toBe("p2");
    expect(out.generate?.quality).toBe("p2q");
  });

  it("merges nested objects without dropping untouched keys", () => {
    const base: Recipe = {
      vision: { shrink: { width: 512, height: 512 } } as Recipe["vision"],
    };
    const patch: Partial<Recipe> = {
      vision: { shrink: { width: 1024 } } as Recipe["vision"],
    };
    const out = mergeRecipes(base, patch);
    expect(out.vision?.shrink).toEqual({ width: 1024, height: 512 });
  });

  it("ignores null/undefined patches", () => {
    const base: Recipe = { generate: { n: 1 } };
    const out = mergeRecipes(
      base,
      null as unknown as Partial<Recipe>,
      undefined as unknown as Partial<Recipe>,
    );
    expect(out).toEqual(base);
  });
});

describe("applyPatch", () => {
  it("deep-merges a JSON string into the recipe", () => {
    const base: Recipe = { generate: { size: "old", n: 1 } };
    const out = applyPatch(base, '{"generate":{"size":"new"}}');
    expect(out.generate?.size).toBe("new");
    expect(out.generate?.n).toBe(1);
  });

  it("throws on invalid JSON", () => {
    expect(() => applyPatch({}, "{not-json")).toThrow(RecipeError);
    try {
      applyPatch({}, "{not-json");
    } catch (err) {
      expect((err as RecipeError).code).toBe("patch.invalidJson");
    }
  });

  it("throws when the patch is not a JSON object", () => {
    expect(() => applyPatch({}, "[1,2,3]")).toThrow(RecipeError);
    expect(() => applyPatch({}, "null")).toThrow(RecipeError);
    expect(() => applyPatch({}, '"string"')).toThrow(RecipeError);
  });
});
