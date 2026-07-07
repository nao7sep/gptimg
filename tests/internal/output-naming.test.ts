import { describe, expect, it } from "vitest";
import {
  imageFileName,
  indexSuffix,
  indexWidth,
} from "../../src/internal/output-naming.js";

describe("indexWidth", () => {
  it("returns 1 for n in 1..9", () => {
    expect(indexWidth(1)).toBe(1);
    expect(indexWidth(4)).toBe(1);
    expect(indexWidth(9)).toBe(1);
  });

  it("returns 2 for n in 10..99", () => {
    expect(indexWidth(10)).toBe(2);
    expect(indexWidth(12)).toBe(2);
  });

  it("returns 3 for n in 100..999", () => {
    expect(indexWidth(100)).toBe(3);
  });

  it("handles n <= 0 defensively", () => {
    expect(indexWidth(0)).toBe(1);
  });
});

describe("indexSuffix", () => {
  it("returns empty when n <= 1", () => {
    expect(indexSuffix(1, 1)).toBe("");
  });

  it("zero-pads to the width of n", () => {
    expect(indexSuffix(1, 4)).toBe("-1");
    expect(indexSuffix(2, 12)).toBe("-02");
    expect(indexSuffix(3, 100)).toBe("-003");
    expect(indexSuffix(99, 100)).toBe("-099");
    expect(indexSuffix(100, 100)).toBe("-100");
  });
});

describe("imageFileName", () => {
  it("does not append index for n=1", () => {
    expect(imageFileName("stem", 1, 1, "png")).toBe("stem.png");
  });

  it("appends zero-padded index for n>1", () => {
    expect(imageFileName("stem", 1, 4, "png")).toBe("stem-1.png");
    expect(imageFileName("stem", 3, 12, "jpg")).toBe("stem-03.jpg");
  });
});
