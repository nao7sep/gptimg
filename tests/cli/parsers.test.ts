import { describe, expect, it } from "vitest";
import { hexOption, numberArg, pointArg } from "../../src/cli/parsers.js";

describe("numberArg: format coercion only", () => {
  const parse = numberArg("--x");

  it("accepts well-formed numbers, including ones the SDK may later reject", () => {
    expect(parse("5")).toBe(5);
    expect(parse("0")).toBe(0);
    expect(parse("-3.5")).toBe(-3.5);
    expect(parse("0.82")).toBe(0.82);
    expect(parse("1e3")).toBe(1000);
    // Surrounding whitespace is tolerated (Number() trims it).
    expect(parse("  5  ")).toBe(5);
    // Out-of-range / non-integer values pass coercion — bounds are the SDK's job.
    expect(parse("99999")).toBe(99999);
    expect(parse("1.5")).toBe(1.5);
  });

  it("rejects anything that is not a finite number", () => {
    for (const bad of [
      "abc",
      "5px",
      "1,2",
      "NaN",
      "Infinity",
      "-Infinity",
      "",
      "   ",
    ]) {
      expect(() => parse(bad), bad).toThrow("--x: must be a number");
    }
  });

  it("names the offending flag in the error", () => {
    expect(() => numberArg("--blur")("nope")).toThrow("--blur: must be a number");
  });
});

describe("pointArg: x,y format coercion only", () => {
  const parse = pointArg("--off");

  it("accepts two comma-separated numbers", () => {
    expect(parse("1,2")).toEqual({ x: 1, y: 2 });
    expect(parse("0,0")).toEqual({ x: 0, y: 0 });
    expect(parse("-1,-2")).toEqual({ x: -1, y: -2 });
    // Surrounding whitespace is trimmed.
    expect(parse("  3,4  ")).toEqual({ x: 3, y: 4 });
    // Decimals pass the format gate; the SDK enforces integer-ness and limits.
    expect(parse("1.5,2.5")).toEqual({ x: 1.5, y: 2.5 });
    expect(parse("99999,-99999")).toEqual({ x: 99999, y: -99999 });
  });

  it("rejects anything that is not exactly two numbers", () => {
    for (const bad of [
      "1",
      "1,",
      ",2",
      "1,2,3",
      "1, 2", // internal space
      "1;2",
      "1.,2", // dangling decimal point
      ".5,2", // missing integer part
      "abc",
      "",
    ]) {
      expect(() => parse(bad), bad).toThrow('--off: must be "x,y"');
    }
  });
});

describe("hexOption: unchanged #rrggbb coercion", () => {
  const parse = hexOption("--color");

  it("accepts #rrggbb and rejects the rest", () => {
    expect(parse("#00ff00")).toBe("#00ff00");
    for (const bad of ["green", "#fff", "00ff00", "#0g0000"]) {
      expect(() => parse(bad), bad).toThrow("--color: must be #rrggbb");
    }
  });
});
