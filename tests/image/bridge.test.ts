import { describe, expect, it } from "vitest";
import { resizeSingleChannel } from "../../src/image/bridge.js";

describe("resizeSingleChannel", () => {
  it("upsizes single-channel data and stays one channel (exact dstW*dstH bytes)", async () => {
    // The reason this helper exists: sharp can widen a 1-channel raw buffer to
    // 3 channels mid-resize, which would triple the byte count and desync any
    // per-pixel recombine. The output must be exactly one byte per pixel.
    const src = new Uint8Array([0, 85, 170, 255]); // 2x2 gradient
    const out = await resizeSingleChannel(src, 2, 2, 8, 8);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(8 * 8);
  });

  it("downsizes a flat field to the exact target size, preserving the value", async () => {
    const src = new Uint8Array(16 * 16).fill(128);
    const out = await resizeSingleChannel(src, 16, 16, 4, 4, "nearest");
    expect(out.length).toBe(4 * 4);
    expect([...out].every((v) => v === 128)).toBe(true);
  });
});
