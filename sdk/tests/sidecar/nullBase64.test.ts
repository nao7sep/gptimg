import { describe, expect, it } from "vitest";
import { nullBase64InResponse } from "../../src/sidecar/nullBase64.ts";

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

  it("keeps a field named __proto__ as a field and still nulls its payload", () => {
    const out = nullBase64InResponse(JSON.parse('{"__proto__":{"b64_json":"AAAA"},"x":1}')) as object;
    expect(Object.keys(out)).toEqual(["__proto__", "x"]);
    expect(JSON.stringify(out)).toBe('{"__proto__":{"b64_json":null},"x":1}');
  });

  it("nulls a Responses image call's result but keeps every other result field", () => {
    const out = nullBase64InResponse({
      output: [
        { type: "image_generation_call", id: "ig_1", result: "AAAA", revised_prompt: "a cat" },
        { type: "other_tool_call", result: "kept" },
      ],
    });
    expect(out).toEqual({
      output: [
        { type: "image_generation_call", id: "ig_1", result: null, revised_prompt: "a cat" },
        { type: "other_tool_call", result: "kept" },
      ],
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
