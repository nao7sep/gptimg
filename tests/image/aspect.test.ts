import { describe, expect, it } from "vitest";
import { fitLongerSide } from "../../src/image/aspect.js";

describe("fitLongerSide", () => {
  it("sets the longer side to toSize for landscape input", () => {
    expect(fitLongerSide(200, 100, 50)).toEqual({ w: 50, h: 25 });
  });

  it("sets the longer side to toSize for portrait input", () => {
    expect(fitLongerSide(100, 200, 50)).toEqual({ w: 25, h: 50 });
  });

  it("treats a square as landscape (width >= height)", () => {
    expect(fitLongerSide(100, 100, 50)).toEqual({ w: 50, h: 50 });
  });

  it("rounds the shorter side", () => {
    // 2 * 2 / 3 = 1.333 -> 1
    expect(fitLongerSide(3, 2, 2)).toEqual({ w: 2, h: 1 });
  });

  it("clamps the shorter side to at least 1px on extreme aspect ratios", () => {
    // Landscape: 10 * 1 / 1000 = 0.01 -> would round to 0, clamped to 1.
    expect(fitLongerSide(1000, 1, 10)).toEqual({ w: 10, h: 1 });
    // Portrait: same clamp on the width axis.
    expect(fitLongerSide(1, 1000, 10)).toEqual({ w: 1, h: 10 });
  });

  it("can scale up as well as down", () => {
    expect(fitLongerSide(100, 50, 400)).toEqual({ w: 400, h: 200 });
  });
});
