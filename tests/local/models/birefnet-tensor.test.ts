/**
 * Unit tests for BiRefNet's pure tensor math (extracted from the ONNX wrapper so
 * it can be tested without the runtime or model weights): the ImageNet input
 * normalization and the logit→alpha output mapping, including the explicit
 * output-shape validation.
 */

import { describe, expect, it } from "vitest";
import { LocalOpError } from "../../../src/errors.js";
import { logitsToAlpha, normalizeImageNet } from "../../../src/local/models/birefnet-tensor.js";

describe("normalizeImageNet", () => {
  it("rescales to [0,1] then applies ImageNet mean/std in planar NCHW layout", () => {
    const size = 2; // 2x2, every pixel pure red (255,0,0)
    const rgb = new Uint8Array(size * size * 3);
    for (let i = 0; i < rgb.length; i += 3) rgb[i] = 255;

    const out = normalizeImageNet(rgb, size);
    const n = size * size;
    expect(out.length).toBe(3 * n);

    const r = (1 - 0.485) / 0.229;
    const g = (0 - 0.456) / 0.224;
    const b = (0 - 0.406) / 0.225;
    for (let p = 0; p < n; p++) {
      expect(out[p]).toBeCloseTo(r, 5); // R plane
      expect(out[n + p]).toBeCloseTo(g, 5); // G plane
      expect(out[2 * n + p]).toBeCloseTo(b, 5); // B plane
    }
  });
});

describe("logitsToAlpha", () => {
  const sigU8 = (v: number) => Math.max(0, Math.min(255, Math.round((1 / (1 + Math.exp(-v))) * 255)));

  it("maps logits through the sigmoid to u8 alpha and reads H/W from dims", () => {
    const data = Float32Array.from([0, 100, -100, 2]);
    const { alpha, width, height } = logitsToAlpha(data, [1, 1, 2, 2]);
    expect(width).toBe(2);
    expect(height).toBe(2);
    expect(alpha[0]).toBe(128); // sigmoid(0)=0.5 → round(127.5)=128
    expect(Array.from(alpha)).toEqual([sigU8(0), 255, 0, sigU8(2)]);
  });

  it("rejects a shape that is not [1,1,H,W]", () => {
    expect(() => logitsToAlpha(Float32Array.from([0, 0]), [1, 2, 1, 1])).toThrow(LocalOpError);
    expect(() => logitsToAlpha(Float32Array.from([0]), [1, 1])).toThrow(LocalOpError);
  });

  it("rejects non-positive spatial dims", () => {
    expect(() => logitsToAlpha(Float32Array.from([]), [1, 1, 0, 2])).toThrow(LocalOpError);
  });

  it("rejects a data length that does not match the dims", () => {
    expect(() => logitsToAlpha(Float32Array.from([0, 0, 0]), [1, 1, 2, 2])).toThrow(LocalOpError);
  });
});
