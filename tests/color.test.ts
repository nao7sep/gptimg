import { describe, expect, it } from "vitest";
import { isHexColor, parseHex, normalizeHex } from "../src/color.js";
import { LocalOpError } from "../src/errors.js";

describe("isHexColor", () => {
  it("accepts #rrggbb in either case", () => {
    expect(isHexColor("#00ff00")).toBe(true);
    expect(isHexColor("#00FF00")).toBe(true);
    expect(isHexColor("#AbCdEf")).toBe(true);
  });

  it("requires the leading # and exactly six digits", () => {
    expect(isHexColor("00ff00")).toBe(false);
    expect(isHexColor("#abc")).toBe(false);
    expect(isHexColor("#0000000")).toBe(false);
    expect(isHexColor("#gggggg")).toBe(false);
    expect(isHexColor("")).toBe(false);
  });
});

describe("parseHex", () => {
  it("extracts the [r, g, b] byte triple", () => {
    expect(parseHex("#ff8000")).toEqual([255, 128, 0]);
    expect(parseHex("#000000")).toEqual([0, 0, 0]);
    expect(parseHex("#ffffff")).toEqual([255, 255, 255]);
  });

  it("tolerates a missing leading #", () => {
    expect(parseHex("ff8000")).toEqual([255, 128, 0]);
  });
});

describe("normalizeHex", () => {
  it("canonicalizes to lowercase #rrggbb", () => {
    expect(normalizeHex("#00FF00")).toBe("#00ff00");
    expect(normalizeHex("#AbCdEf")).toBe("#abcdef");
    expect(normalizeHex("#000000")).toBe("#000000");
  });

  it("throws LocalOpError args.invalid on malformed input", () => {
    expect(() => normalizeHex("nope")).toThrowError(LocalOpError);
    try {
      normalizeHex("nope");
      expect.unreachable("normalizeHex should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LocalOpError);
      expect((err as LocalOpError).code).toBe("args.invalid");
      // Default label and the offending value both appear in the message.
      expect((err as LocalOpError).message).toContain("color");
      expect((err as LocalOpError).message).toContain("nope");
    }
  });

  it("names the offending value with the provided label", () => {
    try {
      normalizeHex("#xyz", "--from");
      expect.unreachable("normalizeHex should have thrown");
    } catch (err) {
      expect((err as LocalOpError).message).toContain("--from");
    }
  });
});
