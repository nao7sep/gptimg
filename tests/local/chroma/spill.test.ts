import { describe, expect, it } from "vitest";
import {
  analyzeKey,
  spillAlpha,
  linearizeRGBA,
  linearToSRGBByte,
  SRGB_TO_LINEAR_LUT,
} from "../../../src/local/chroma/spill.js";

describe("analyzeKey", () => {
  it("classifies a dominant channel as a primary key", () => {
    // Pure green in linear-light: G dominant.
    expect(analyzeKey([0, 1, 0])).toEqual({
      kind: "primary",
      channel: 1,
      strength: 1,
    });
  });

  it("classifies a suppressed channel as a secondary key", () => {
    // Yellow in linear-light (R+G high, B suppressed).
    expect(analyzeKey([1, 1, 0])).toEqual({
      kind: "secondary",
      suppressed: 2,
      strength: 1,
    });
  });

  it("returns null for very dark keys (max below MIN_KEY_STRENGTH)", () => {
    expect(analyzeKey([0.01, 0.02, 0.0])).toBeNull();
  });

  it("returns null for achromatic keys (channel gap below MIN_CHANNEL_GAP)", () => {
    expect(analyzeKey([0.5, 0.5, 0.5])).toBeNull();
    // Bright but nearly flat — gaps stay under 0.05.
    expect(analyzeKey([0.5, 0.52, 0.49])).toBeNull();
  });

  it("breaks an exact primary/secondary tie in favor of primary", () => {
    // Exactly-representable tie: max-mid (0.25) equals mid-min (0.25), so the
    // `primaryGap >= secondaryGap` comparison picks primary.
    expect(analyzeKey([0, 0.25, 0.5])).toEqual({
      kind: "primary",
      channel: 2,
      strength: 0.5,
    });
  });
});

describe("spillAlpha", () => {
  const greenKey = { kind: "primary", channel: 1, strength: 1 } as const;

  it("drives a pure-key pixel to alpha 0", () => {
    const out = spillAlpha(
      Float32Array.of(0),
      Float32Array.of(1),
      Float32Array.of(0),
      greenKey,
      1,
    );
    expect(out[0]).toBe(0);
  });

  it("keeps a pixel with no key contamination fully opaque", () => {
    // Magenta: green channel below the other two -> spill <= 0 -> 255.
    const out = spillAlpha(
      Float32Array.of(1),
      Float32Array.of(0),
      Float32Array.of(1),
      greenKey,
      1,
    );
    expect(out[0]).toBe(255);
  });

  it("scales partial spill proportionally", () => {
    // pivot 0.5, others 0 -> spill 0.5, ratio 0.5 -> round(0.5 * 255) = 128.
    const out = spillAlpha(
      Float32Array.of(0),
      Float32Array.of(0.5),
      Float32Array.of(0),
      greenKey,
      1,
    );
    expect(out[0]).toBe(128);
  });

  it("rescales the soft range with saturationRatio < 1", () => {
    // Same 0.5 spill, but sat 0.5 doubles the ratio to 1 -> snaps to 0.
    const out = spillAlpha(
      Float32Array.of(0),
      Float32Array.of(0.5),
      Float32Array.of(0),
      greenKey,
      0.5,
    );
    expect(out[0]).toBe(0);
  });

  it("clamps saturationRatio above 1 back to 1", () => {
    const soft = spillAlpha(
      Float32Array.of(0),
      Float32Array.of(0.5),
      Float32Array.of(0),
      greenKey,
      5,
    );
    expect(soft[0]).toBe(128);
  });

  it("handles a secondary key via the suppressed channel", () => {
    // Suppressed = blue (channel 2). Pure yellow pixel (B=0) -> spill = strength -> 0.
    const yellowKey = { kind: "secondary", suppressed: 2, strength: 1 } as const;
    const out = spillAlpha(
      Float32Array.of(1),
      Float32Array.of(1),
      Float32Array.of(0),
      yellowKey,
      1,
    );
    expect(out[0]).toBe(0);
  });
});

describe("linearToSRGBByte", () => {
  it("clamps non-positive and non-finite input to 0", () => {
    // The `!Number.isFinite(v)` guard runs before the `v >= 1` check, so
    // Infinity is treated as non-finite and floored to 0, not capped at 255.
    expect(linearToSRGBByte(0)).toBe(0);
    expect(linearToSRGBByte(-0.5)).toBe(0);
    expect(linearToSRGBByte(Number.NaN)).toBe(0);
    expect(linearToSRGBByte(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("clamps input at or above 1 to 255", () => {
    expect(linearToSRGBByte(1)).toBe(255);
    expect(linearToSRGBByte(2)).toBe(255);
  });

  it("round-trips the sRGB LUT within rounding tolerance", () => {
    for (const i of [1, 64, 128, 200, 254]) {
      expect(linearToSRGBByte(SRGB_TO_LINEAR_LUT[i]!)).toBeCloseTo(i, 0);
    }
  });
});

describe("linearizeRGBA", () => {
  it("maps each channel through the sRGB->linear LUT, ignoring alpha", () => {
    const rgba = Uint8Array.of(0, 0, 0, 255, 255, 255, 255, 128);
    const { linR, linG, linB } = linearizeRGBA(rgba);
    expect(linR[0]).toBe(0);
    expect(linG[0]).toBe(0);
    expect(linB[0]).toBe(0);
    expect(linR[1]).toBeCloseTo(1, 5);
    expect(linG[1]).toBeCloseTo(1, 5);
    expect(linB[1]).toBeCloseTo(1, 5);
  });
});
