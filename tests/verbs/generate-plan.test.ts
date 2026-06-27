import { describe, expect, it } from "vitest";
import { LocalOpError } from "../../src/errors.js";
import { planGenerateOutputs, type DetectedImage } from "../../src/verbs/generate-plan.js";
import type { DetectedFormat } from "../../src/image/detectFormat.js";

function fmt(extension: string, format = extension): DetectedFormat {
  return { format, extension };
}
function ok(extension: string): DetectedImage {
  return { format: fmt(extension) };
}
const fail: DetectedImage = { format: null };

describe("planGenerateOutputs", () => {
  it("names a single image with no suffix", () => {
    const plan = planGenerateOutputs(1, "shot", [ok("png")]);
    expect(plan.suffixCount).toBe(1);
    expect(plan.partial).toBe(false);
    expect(plan.groupExtension).toBe("png");
    expect(plan.images).toEqual([{ index: 1, format: fmt("png"), fileName: "shot.png" }]);
  });

  it("suffixes each image by its 1-based index, padded to the digit-count of n", () => {
    const plan = planGenerateOutputs(3, "shot", [ok("png"), ok("png"), ok("png")]);
    expect(plan.suffixCount).toBe(3);
    // n=3 is one digit, so no zero-padding.
    expect(plan.images.map((i) => i.fileName)).toEqual(["shot-1.png", "shot-2.png", "shot-3.png"]);
  });

  it("zero-pads the suffix once the count reaches two digits", () => {
    const detected = Array.from({ length: 10 }, () => ok("png"));
    const plan = planGenerateOutputs(10, "shot", detected);
    expect(plan.suffixCount).toBe(10);
    expect(plan.images[0]!.fileName).toBe("shot-01.png");
    expect(plan.images[9]!.fileName).toBe("shot-10.png");
  });

  it("keeps a failed image's index as a gap rather than compacting (stable provenance)", () => {
    const plan = planGenerateOutputs(3, "shot", [ok("png"), fail, ok("png")]);
    expect(plan.partial).toBe(true);
    expect(plan.images.map((i) => i.index)).toEqual([1, 3]);
    expect(plan.images.map((i) => i.fileName)).toEqual(["shot-1.png", "shot-3.png"]);
  });

  it("widens the suffix to the larger of n and the actual return", () => {
    const plan = planGenerateOutputs(1, "shot", [ok("png"), ok("png")]);
    expect(plan.suffixCount).toBe(2);
    expect(plan.images.map((i) => i.fileName)).toEqual(["shot-1.png", "shot-2.png"]);
  });

  it("derives the group extension from the first surviving image", () => {
    const plan = planGenerateOutputs(2, "shot", [fail, ok("jpg")]);
    expect(plan.groupExtension).toBe("jpg");
    expect(plan.images.map((i) => i.fileName)).toEqual(["shot-2.jpg"]);
  });

  it("falls back to png when nothing succeeded", () => {
    const plan = planGenerateOutputs(2, "shot", [fail, fail]);
    expect(plan.images).toEqual([]);
    expect(plan.groupExtension).toBe("png");
    expect(plan.partial).toBe(true);
  });

  it("rejects a group whose surviving images carry mixed extensions", () => {
    let caught: unknown;
    try {
      planGenerateOutputs(2, "shot", [ok("png"), ok("jpg")]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LocalOpError);
    expect((caught as LocalOpError).code).toBe("output.mixedExtensions");
  });
});
