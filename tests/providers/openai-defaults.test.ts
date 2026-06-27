import { describe, expect, it } from "vitest";
import { shouldOmitResponseFormat } from "../../src/providers/openai/defaults.js";

describe("shouldOmitResponseFormat", () => {
  it("omits response_format for gpt-image-* models (they reject it)", () => {
    expect(shouldOmitResponseFormat("gpt-image-2")).toBe(true);
    expect(shouldOmitResponseFormat("gpt-image-1")).toBe(true);
  });

  it("keeps response_format for models that accept it", () => {
    expect(shouldOmitResponseFormat("dall-e-3")).toBe(false);
    expect(shouldOmitResponseFormat("gpt-5.4-mini")).toBe(false);
  });
});
