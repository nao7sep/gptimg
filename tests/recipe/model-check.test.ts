import { describe, expect, it } from "vitest";

import { SUPPORTED_MODELS, type ImageModelRow, type VisionModelRow } from "../../src/ai-models.js";
import { RecipeError } from "../../src/errors.js";
import { checkImageParams, resolveVisionReasoning } from "../../src/recipe/model-check.js";

const imageRows = SUPPORTED_MODELS.filter((row): row is ImageModelRow => "image" in row);
const visionRows = SUPPORTED_MODELS.filter((row): row is VisionModelRow => "thinking" in row);

function refusal(run: () => unknown): RecipeError {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(RecipeError);
    expect((err as RecipeError).code).toBe("recipe.validationFailed");
    return err as RecipeError;
  }
  throw new Error("expected a refusal");
}

describe("checkImageParams", () => {
  it("accepts every value each supported row lists, in both sections", () => {
    for (const row of imageRows) {
      for (const section of ["generate", "edit"] as const) {
        for (const quality of row.image.qualities) checkImageParams(section, { model: row.id, quality });
        for (const background of row.image.backgrounds) checkImageParams(section, { model: row.id, background, output_format: "png" });
        for (const output_format of row.image.outputFormats) checkImageParams(section, { model: row.id, output_format });
      }
    }
  });

  it("refuses a quality the row does not list, naming the model and what it takes", () => {
    const err = refusal(() => checkImageParams("generate", { model: "gpt-image-2", quality: "xhigh" }));
    expect(err.message).toBe('generate section invalid: gpt-image-2 takes quality auto, low, medium, high, not "xhigh".');
    refusal(() => checkImageParams("edit", { model: "gpt-image-2.5-sunburst", quality: "ultra" }));
  });

  it("refuses an unlisted background or output format", () => {
    refusal(() => checkImageParams("generate", { model: "gpt-image-2.5-flare", background: "white" }));
    refusal(() => checkImageParams("edit", { model: "gpt-image-2.5-flare", output_format: "gif" }));
  });

  it("refuses a transparent background with jpeg, and takes it with png, webp or the default", () => {
    const err = refusal(() =>
      checkImageParams("generate", { model: "gpt-image-2.5-flare", background: "transparent", output_format: "jpeg" }),
    );
    expect(err.message).toContain("transparent background needs output_format png or webp");
    checkImageParams("generate", { model: "gpt-image-2.5-flare", background: "transparent", output_format: "webp" });
    checkImageParams("generate", { model: "gpt-image-2.5-flare", background: "transparent", output_format: "png" });
    checkImageParams("generate", { model: "gpt-image-2.5-flare", background: "transparent" });
  });

  it("takes compression 0 to 100 for jpeg and webp only", () => {
    for (const output_format of ["jpeg", "webp"]) {
      for (const output_compression of [0, 55, 100]) {
        checkImageParams("generate", { model: "gpt-image-2", output_format, output_compression });
      }
      refusal(() => checkImageParams("generate", { model: "gpt-image-2", output_format, output_compression: 101 }));
      refusal(() => checkImageParams("generate", { model: "gpt-image-2", output_format, output_compression: -1 }));
      refusal(() => checkImageParams("generate", { model: "gpt-image-2", output_format, output_compression: 50.5 }));
    }
    refusal(() => checkImageParams("edit", { model: "gpt-image-2", output_format: "png", output_compression: 80 }));
    refusal(() => checkImageParams("edit", { model: "gpt-image-2", output_compression: 80 }));
  });

  it("takes auto and sizes within the rule, and refuses the rest", () => {
    for (const size of ["auto", "1024x1024", "1024x640", "640x1024", "3840x2160", "1536x1024", "2400x800"]) {
      checkImageParams("generate", { model: "gpt-image-2.5-flare", size });
    }
    const cases: Array<[string, string]> = [
      ["1000x1000", "divisible by 16"],
      ["2448x800", "3:1 ratio"],
      ["800x800", "655,360 to 8,294,400 pixels"],
      ["4096x2160", "655,360 to 8,294,400 pixels"],
      ["big", '"auto" or WIDTHxHEIGHT'],
    ];
    for (const [size, reason] of cases) {
      expect(refusal(() => checkImageParams("edit", { model: "gpt-image-2", size })).message, size).toContain(reason);
    }
  });

  it("does not check an id with no row, a removed one included", () => {
    for (const model of ["some-future-image-model", "gpt-image-1.5", "gpt-image-1-mini"]) {
      checkImageParams("generate", {
        model,
        quality: "xhigh",
        background: "transparent",
        output_format: "jpeg",
        output_compression: 500,
        size: "17x9",
      });
    }
  });
});

describe("resolveVisionReasoning", () => {
  it("defaults each supported row to its own tier's default", () => {
    expect(Object.fromEntries(visionRows.map((row) => [row.id, resolveVisionReasoning(row.id, undefined)]))).toEqual({
      "gpt-6-astra": "medium",
      "gpt-6.1-sol": "medium",
      "gpt-5.6-terra": "medium",
      "gpt-6-luna": "none",
    });
  });

  it("returns every listed effort as chosen", () => {
    for (const row of visionRows) {
      for (const value of row.thinking) expect(resolveVisionReasoning(row.id, value), `${row.id} ${value}`).toBe(value);
    }
  });

  it("refuses an effort the row does not list", () => {
    const err = refusal(() => resolveVisionReasoning("gpt-6-astra", "none"));
    expect(err.message).toBe('vision section invalid: gpt-6-astra takes reasoning low, medium, high, xhigh, max, not "none".');
    refusal(() => resolveVisionReasoning("gpt-6-luna", "minimal"));
  });

  it("passes an unlisted or removed id's effort through unchecked, and invents none", () => {
    for (const model of ["some-future-chat-model", "gpt-5.6-sol", "gpt-5.6-luna"]) {
      expect(resolveVisionReasoning(model, undefined), model).toBeUndefined();
      expect(resolveVisionReasoning(model, "anything"), model).toBe("anything");
    }
  });
});
