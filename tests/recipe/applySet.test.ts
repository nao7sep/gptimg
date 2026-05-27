import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecipeError } from "../../src/errors.js";
import { applySet } from "../../src/recipe/applySet.js";
import type { Recipe } from "../../src/types.js";

describe("applySet", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-test-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns the input unchanged when no expressions are given", async () => {
    const r: Recipe = { generate: { size: "1024x1024" } };
    const out = await applySet(r, "generate", []);
    expect(out).toEqual(r);
  });

  it("sets simple scalar fields and JSON-parses values", async () => {
    const out = await applySet({}, "generate", [
      "size=1024x1024",
      "n=4",
      "draft=true",
      "missing=null",
    ]);
    expect(out.generate).toEqual({
      size: "1024x1024",
      n: 4,
      draft: true,
      missing: null,
    });
  });

  it("falls back to raw string when the value is not JSON", async () => {
    const out = await applySet({}, "generate", ["model=gpt-image-1"]);
    expect(out.generate?.model).toBe("gpt-image-1");
  });

  it("sets nested fields via dot path", async () => {
    const out = await applySet({}, "generate", ["a.b.c=42"]);
    expect(out.generate).toEqual({ a: { b: { c: 42 } } });
  });

  it("indexes arrays via numeric segments", async () => {
    const out = await applySet({}, "generate", [
      "tools.0.type=image_generation",
      "tools.0.enabled=true",
    ]);
    expect(out.generate?.tools).toEqual([
      { type: "image_generation", enabled: true },
    ]);
  });

  it("reads a JSON value from @file", async () => {
    const filePath = path.join(tmp, "value.json");
    await writeFile(filePath, JSON.stringify({ width: 1024, height: 1024 }));
    const out = await applySet({}, "vision", [`shrink=@${filePath}`]);
    expect(out.vision?.shrink).toEqual({ width: 1024, height: 1024 });
  });

  it("treats @file with non-JSON content as a raw string", async () => {
    const filePath = path.join(tmp, "value.txt");
    await writeFile(filePath, "just a string");
    const out = await applySet({}, "generate", [`prompt=@${filePath}`]);
    expect(out.generate?.prompt).toBe("just a string");
  });

  it("throws RecipeError when '=' is missing", async () => {
    await expect(applySet({}, "generate", ["no-equals"])).rejects.toBeInstanceOf(
      RecipeError,
    );
  });

  it("throws RecipeError when the key is empty", async () => {
    await expect(applySet({}, "generate", ["=value"])).rejects.toBeInstanceOf(
      RecipeError,
    );
  });

  it("does not mutate the input recipe", async () => {
    const r: Recipe = { generate: { size: "old" } };
    const snapshot = JSON.stringify(r);
    await applySet(r, "generate", ["size=new"]);
    expect(JSON.stringify(r)).toBe(snapshot);
  });

  it("treats network.* as a recipe-rooted path, not verb-scoped", async () => {
    const out = await applySet({}, "generate", [
      "network.imageGenerate.timeout=120000",
    ]);
    expect((out as Record<string, unknown>).network).toEqual({
      imageGenerate: { timeout: 120000 },
    });
    expect(out.generate?.network).toBeUndefined();
  });

  it("JSON-parses inline array values for retryIntervals", async () => {
    const out = await applySet({}, "generate", [
      "network.imageGenerate.retryIntervals=[1000,2000,4000]",
    ]);
    expect(
      ((out as Record<string, unknown>).network as Record<string, { retryIntervals?: unknown }>)
        .imageGenerate?.retryIntervals,
    ).toEqual([1000, 2000, 4000]);
  });

  it("treats verb-shaped top-level keys (generate, edit, vision) as recipe-rooted", async () => {
    const out = await applySet({}, "generate", ["edit.size=512x512"]);
    expect(out.edit?.size).toBe("512x512");
    expect(out.generate?.edit).toBeUndefined();
  });

  it("still scopes bare keys under the current verb", async () => {
    const out = await applySet({}, "vision", ["custom=value"]);
    expect(out.vision?.custom).toBe("value");
  });
});
