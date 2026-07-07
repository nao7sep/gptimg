/**
 * Unit tests for Swin2SR's pure tensor encode/decode (extracted from the ONNX
 * wrapper): interleaved-RGB → planar [0,1] packing, and the planar-CHW → clamped
 * interleaved-u8 unpacking with its output-shape validation. The tiling/stitch
 * geometry is covered separately in tests/local/upscale.test.ts.
 */

import { describe, expect, it } from "vitest";
import { LocalOpError } from "../../../src/errors.js";
import { packNchw01, unpackChwToU8 } from "../../../src/local/models/swin2sr-tensor.js";

describe("packNchw01", () => {
  it("rescales interleaved RGB u8 to planar [0,1] float32 (no mean subtraction)", () => {
    const rgb = Uint8Array.from([255, 0, 128, 0, 255, 64]); // 2x1: (255,0,128) (0,255,64)
    const out = packNchw01(rgb, 2, 1);
    const n = 2;
    expect(out.length).toBe(3 * n);
    expect(out[0]).toBeCloseTo(1, 5); // R0
    expect(out[1]).toBeCloseTo(0, 5); // R1
    expect(out[n + 0]).toBeCloseTo(0, 5); // G0
    expect(out[n + 1]).toBeCloseTo(1, 5); // G1
    expect(out[2 * n + 0]).toBeCloseTo(128 / 255, 5); // B0
    expect(out[2 * n + 1]).toBeCloseTo(64 / 255, 5); // B1
  });
});

describe("unpackChwToU8", () => {
  it("clamps planar CHW float to interleaved u8 in [0,255]", () => {
    const ow = 2;
    const oh = 1;
    // R [1.5, -0.2]  G [0.5, 0]  B [0.25, 2]
    const data = Float32Array.from([1.5, -0.2, 0.5, 0, 0.25, 2]);
    const out = unpackChwToU8(data, [1, 3, oh, ow], ow, oh);
    expect(Array.from(out)).toEqual([255, 128, 64, 0, 0, 255]);
  });

  it("rejects an output shape that is not [1,3,oh,ow]", () => {
    const data = Float32Array.from([0, 0, 0]);
    expect(() => unpackChwToU8(data, [1, 1, 1, 1], 1, 1)).toThrow(LocalOpError);
    expect(() => unpackChwToU8(data, [1, 3, 2, 2], 1, 1)).toThrow(LocalOpError);
  });
});
