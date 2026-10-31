import { describe, expect, it } from "vitest";
import { parseSize, sizeProblem, sizeRuleOf } from "../../src/shared/image-size.ts";
import { parseUiState } from "../../src/shared/ui-state.ts";

describe("an exact size", () => {
  const rule = sizeRuleOf("gpt-image-2.5-sunburst");

  it("follows the supported image model's rule, and any size for a model the SDK does not list", () => {
    expect(rule).toEqual({ multipleOf: 16, maxRatio: 3, minPixels: 655_360, maxPixels: 8_294_400 });
    expect(sizeProblem(3840, 2160, rule)).toBeNull();
    expect(sizeProblem(1024, 640, rule)).toBeNull();
    expect(sizeProblem(1000, 1000, rule)).toBe("multiple");
    expect(sizeProblem(3072, 1008, rule)).toBe("ratio");
    expect(sizeProblem(800, 800, rule)).toBe("small");
    expect(sizeProblem(3200, 3200, rule)).toBe("large");
    expect(sizeProblem(Number.NaN, 1024, rule)).toBe("format");
    expect(sizeProblem(1001, 7, sizeRuleOf("my-own-model"))).toBeNull();
  });

  it("reads WIDTHxHEIGHT and nothing else", () => {
    expect(parseSize("1536x1024")).toEqual({ width: 1536, height: 1024 });
    expect(parseSize("auto")).toBeNull();
  });
});

describe("the composer's remembered choices", () => {
  it("keep a background and keep the images pane open unless closed", () => {
    expect(parseUiState({ composer: { size: "1024x1024", quality: "low", background: "opaque" } }).composer).toEqual({ size: "1024x1024", quality: "low", background: "opaque" });
    expect(parseUiState({ composer: { size: "auto", quality: "auto", background: "sparkly" } }).composer).toEqual({ size: "auto", quality: "auto" });
    expect(parseUiState({}).imagesPane).toBe(true);
    expect(parseUiState({ imagesPane: false }).imagesPane).toBe(false);
  });
});
