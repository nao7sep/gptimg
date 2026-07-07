import { describe, expect, it } from "vitest";
import { nullBase64InResponse } from "../../src/sidecar/nullBase64.js";

describe("nullBase64InResponse", () => {
  it("nulls a top-level b64_json field", () => {
    expect(nullBase64InResponse({ b64_json: "abc==" })).toEqual({
      b64_json: null,
    });
  });

  it("nulls b64_json inside an array, preserving position and siblings", () => {
    const input = {
      created: 123,
      data: [
        { b64_json: "AAA", revised_prompt: "p1" },
        { b64_json: "BBB", revised_prompt: "p2" },
      ],
    };
    const out = nullBase64InResponse(input) as typeof input;
    expect(out.created).toBe(123);
    expect(out.data).toHaveLength(2);
    expect(out.data[0]).toEqual({ b64_json: null, revised_prompt: "p1" });
    expect(out.data[1]).toEqual({ b64_json: null, revised_prompt: "p2" });
  });

  it("leaves non-base64 fields untouched", () => {
    const input = { data: [{ url: "https://example.com/x.png" }] };
    expect(nullBase64InResponse(input)).toEqual(input);
  });

  it("nulls alternative known base64 field names", () => {
    expect(nullBase64InResponse({ image_b64: "x", image_base64: "y" })).toEqual({
      image_b64: null,
      image_base64: null,
    });
  });

  it("does not mutate the input", () => {
    const input = { data: [{ b64_json: "AAA" }] };
    const snapshot = JSON.stringify(input);
    nullBase64InResponse(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("handles primitives, null, undefined, and empty values", () => {
    expect(nullBase64InResponse(null)).toBeNull();
    expect(nullBase64InResponse(undefined)).toBeUndefined();
    expect(nullBase64InResponse("plain")).toBe("plain");
    expect(nullBase64InResponse(42)).toBe(42);
    expect(nullBase64InResponse([])).toEqual([]);
    expect(nullBase64InResponse({})).toEqual({});
  });
});
