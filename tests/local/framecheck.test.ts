import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFramecheck } from "../../src/local/framecheck.js";

async function writeRawPng(
  filePath: string,
  width: number,
  height: number,
  rgba: Uint8Array,
): Promise<void> {
  await sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } })
    .png()
    .toFile(filePath);
}

function blank(W: number, H: number): Uint8Array {
  return new Uint8Array(W * H * 4);
}
function fillRect(
  buf: Uint8Array,
  W: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgba: [number, number, number, number],
): void {
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = (y * W + x) * 4;
      buf[i] = rgba[0];
      buf[i + 1] = rgba[1];
      buf[i + 2] = rgba[2];
      buf[i + 3] = rgba[3];
    }
}

const SOLID: [number, number, number, number] = [200, 50, 50, 255];
const FAINT: [number, number, number, number] = [200, 50, 50, 50]; // alpha below the 128 threshold

describe("runFramecheck — alpha-coverage geometry", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-framecheck-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  let seq = 0;
  async function build(W: number, H: number, paint: (buf: Uint8Array) => void): Promise<string> {
    const buf = blank(W, H);
    paint(buf);
    const p = path.join(tmp, `in-${seq++}.png`);
    await writeRawPng(p, W, H, buf);
    return p;
  }

  it("a centered solid square → equal margins, zero deltas, verdict centered", async () => {
    const inPath = await build(10, 10, (b) => fillRect(b, 10, 3, 3, 6, 6, SOLID));
    const r = await runFramecheck({ in: inPath });
    expect(r.empty).toBe(false);
    expect(r.solidBBox).toEqual({ x: 3, y: 3, width: 4, height: 4 });
    expect(r.margins).toEqual({ left: 3, right: 3, top: 3, bottom: 3 });
    expect(r.deltas).toEqual({ horizontal: 0, vertical: 0 });
    expect(r.edgeContact).toEqual({ left: false, right: false, top: false, bottom: false });
    expect(r.verdict).toBe("centered");
  });

  it("a horizontally off-centre square → |L−R| over tolerance, verdict offset", async () => {
    const inPath = await build(10, 10, (b) => fillRect(b, 10, 1, 3, 4, 6, SOLID));
    const r = await runFramecheck({ in: inPath });
    expect(r.margins).toEqual({ left: 1, right: 5, top: 3, bottom: 3 });
    expect(r.deltas!.horizontal).toBe(4);
    expect(r.verdict).toBe("offset");
  });

  it("a vertically-offset but horizontally-centred subject: axes selects what the verdict judges", async () => {
    // horiz centred (L=R=3), vertically low (T=1, B=5) — the shadow-like case.
    const inPath = await build(10, 10, (b) => fillRect(b, 10, 3, 1, 6, 4, SOLID));
    const horizontal = await runFramecheck({ in: inPath, axes: "horizontal" });
    expect(horizontal.deltas).toEqual({ horizontal: 0, vertical: 4 });
    expect(horizontal.verdict).toBe("centered"); // vertical asymmetry ignored
    const vertical = await runFramecheck({ in: inPath, axes: "vertical" });
    expect(vertical.verdict).toBe("offset");
    const both = await runFramecheck({ in: inPath, axes: "both" });
    expect(both.verdict).toBe("offset");
  });

  it("measures the SOLID box, so a faint one-sided band (sub-threshold) does NOT skew the verdict", async () => {
    const inPath = await build(12, 12, (b) => {
      fillRect(b, 12, 4, 4, 7, 7, SOLID); // centred opaque square
      fillRect(b, 12, 0, 4, 1, 7, FAINT); // faint band hugging the left edge
    });
    const r = await runFramecheck({ in: inPath });
    // any-alpha box is dragged left to x=0 by the faint band...
    expect(r.anyBBox).toEqual({ x: 0, y: 4, width: 8, height: 4 });
    // ...but the solid box (and thus the verdict) ignores it.
    expect(r.solidBBox).toEqual({ x: 4, y: 4, width: 4, height: 4 });
    expect(r.deltas!.horizontal).toBe(0);
    expect(r.verdict).toBe("centered");
  });

  it("flags edge contact (clipping / zero margin) per side", async () => {
    const inPath = await build(10, 10, (b) => fillRect(b, 10, 0, 0, 3, 3, SOLID)); // top-left corner
    const r = await runFramecheck({ in: inPath });
    expect(r.margins).toEqual({ left: 0, right: 6, top: 0, bottom: 6 });
    expect(r.edgeContact).toEqual({ left: true, right: false, top: true, bottom: false });
    expect(r.verdict).toBe("offset"); // also off-centre, naturally
  });

  it("treats a fully-transparent image as empty and vacuously centered", async () => {
    const inPath = await build(6, 6, () => {});
    const r = await runFramecheck({ in: inPath });
    expect(r.empty).toBe(true);
    expect(r.anyBBox).toBeNull();
    expect(r.solidBBox).toBeNull();
    expect(r.margins).toBeNull();
    expect(r.deltas).toBeNull();
    expect(r.edgeContact).toBeNull();
    expect(r.verdict).toBe("centered");
  });

  it("falls back to the any-alpha box when nothing reaches the solid threshold", async () => {
    const inPath = await build(8, 8, (b) => fillRect(b, 8, 2, 2, 5, 5, FAINT)); // faint centred square
    const r = await runFramecheck({ in: inPath });
    expect(r.empty).toBe(false);
    expect(r.solidBBox).toBeNull();
    expect(r.anyBBox).toEqual({ x: 2, y: 2, width: 4, height: 4 });
    expect(r.margins).toEqual({ left: 2, right: 2, top: 2, bottom: 2 });
    expect(r.verdict).toBe("centered");
  });

  it("honours the threshold (inclusive ≥) for what counts as solid", async () => {
    const inPath = await build(8, 8, (b) => fillRect(b, 8, 2, 2, 5, 5, [200, 50, 50, 128]));
    const at = await runFramecheck({ in: inPath, threshold: 128 });
    expect(at.solidBBox).toEqual({ x: 2, y: 2, width: 4, height: 4 }); // alpha 128 ≥ 128
    const above = await runFramecheck({ in: inPath, threshold: 200 });
    expect(above.solidBBox).toBeNull(); // 128 < 200
  });

  it("honours the tolerance boundary (≤ passes, just beyond fails)", async () => {
    // L=3, R=5 → horizontal delta exactly 2.
    const inPath = await build(12, 10, (b) => fillRect(b, 12, 3, 3, 6, 6, SOLID));
    const r0 = await runFramecheck({ in: inPath, tolerance: 2 });
    expect(r0.deltas!.horizontal).toBe(2);
    expect(r0.verdict).toBe("centered");
    const r1 = await runFramecheck({ in: inPath, tolerance: 1 });
    expect(r1.verdict).toBe("offset");
  });
});

describe("runFramecheck — hard cases", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-framecheck-hard-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  let seq = 0;
  async function build(W: number, H: number, paint: (buf: Uint8Array) => void): Promise<string> {
    const buf = blank(W, H);
    paint(buf);
    const p = path.join(tmp, `hard-${seq++}.png`);
    await writeRawPng(p, W, H, buf);
    return p;
  }

  it("handles a NON-SQUARE canvas without swapping the axes", async () => {
    // 16×8 wide canvas, a 4×2 subject centred at (6,3)-(9,4).
    const inPath = await build(16, 8, (b) => fillRect(b, 16, 6, 3, 9, 4, SOLID));
    const r = await runFramecheck({ in: inPath });
    expect(r.width).toBe(16);
    expect(r.height).toBe(8);
    expect(r.solidBBox).toEqual({ x: 6, y: 3, width: 4, height: 2 });
    expect(r.margins).toEqual({ left: 6, right: 6, top: 3, bottom: 3 });
    expect(r.deltas).toEqual({ horizontal: 0, vertical: 0 });
    expect(r.verdict).toBe("centered");
  });

  it("a FULL-BLEED subject is centered but contacts every edge (the web-icon case)", async () => {
    const inPath = await build(10, 10, (b) => fillRect(b, 10, 0, 0, 9, 9, SOLID));
    const r = await runFramecheck({ in: inPath });
    expect(r.solidBBox).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(r.margins).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
    expect(r.deltas).toEqual({ horizontal: 0, vertical: 0 });
    expect(r.edgeContact).toEqual({ left: true, right: true, top: true, bottom: true });
    expect(r.verdict).toBe("centered"); // edge contact is independent of the centering verdict
  });

  it("is EXTENT-based: one stray solid pixel near an edge flips the verdict (a survived speckle)", async () => {
    const inPath = await build(10, 10, (b) => {
      fillRect(b, 10, 3, 3, 6, 6, SOLID); // a perfectly centred subject...
      fillRect(b, 10, 0, 5, 0, 5, SOLID); // ...plus one opaque pixel hard against the left edge
    });
    const r = await runFramecheck({ in: inPath });
    expect(r.solidBBox).toEqual({ x: 0, y: 3, width: 7, height: 4 }); // box stretched to the speckle
    expect(r.margins!.left).toBe(0);
    expect(r.deltas!.horizontal).toBe(3);
    expect(r.edgeContact!.left).toBe(true);
    expect(r.verdict).toBe("offset");
  });

  it("spans DISCONNECTED components by extent: a symmetric pair stays centered, an asymmetric pair offsets", async () => {
    const sym = await build(10, 10, (b) => {
      fillRect(b, 10, 1, 4, 2, 5, SOLID);
      fillRect(b, 10, 7, 4, 8, 5, SOLID);
    });
    const rs = await runFramecheck({ in: sym });
    expect(rs.solidBBox).toEqual({ x: 1, y: 4, width: 8, height: 2 });
    expect(rs.deltas!.horizontal).toBe(0);
    expect(rs.verdict).toBe("centered");

    const asym = await build(10, 10, (b) => {
      fillRect(b, 10, 0, 4, 1, 5, SOLID);
      fillRect(b, 10, 4, 4, 5, 5, SOLID);
    });
    const ra = await runFramecheck({ in: asym });
    expect(ra.margins!.left).toBe(0);
    expect(ra.deltas!.horizontal).toBe(4);
    expect(ra.verdict).toBe("offset");
  });

  it("separates a soft antialiased ramp from the opaque body (solid box tighter than any box)", async () => {
    // alpha-64 ring (sub-threshold) around an alpha-255 core.
    const inPath = await build(12, 12, (b) => {
      fillRect(b, 12, 3, 3, 8, 8, [200, 50, 50, 64]);
      fillRect(b, 12, 4, 4, 7, 7, SOLID);
    });
    const r = await runFramecheck({ in: inPath });
    expect(r.anyBBox).toEqual({ x: 3, y: 3, width: 6, height: 6 }); // includes the ramp
    expect(r.solidBBox).toEqual({ x: 4, y: 4, width: 4, height: 4 }); // body only
    expect(r.verdict).toBe("centered");
  });

  it("threshold=1 makes the verdict ride the ANY-alpha box (solid == any)", async () => {
    // A faint centred square plus a faint left-edge speckle: at threshold 1 the
    // speckle counts, so the box stretches left and the verdict offsets.
    const inPath = await build(10, 10, (b) => {
      fillRect(b, 10, 3, 3, 6, 6, [200, 50, 50, 50]);
      fillRect(b, 10, 0, 5, 0, 5, [200, 50, 50, 50]);
    });
    const r = await runFramecheck({ in: inPath, threshold: 1 });
    expect(r.solidBBox).toEqual(r.anyBBox);
    expect(r.margins!.left).toBe(0);
    expect(r.verdict).toBe("offset");
  });

  it("a single-pixel subject is located and centered correctly", async () => {
    const inPath = await build(5, 5, (b) => fillRect(b, 5, 2, 2, 2, 2, SOLID));
    const r = await runFramecheck({ in: inPath });
    expect(r.solidBBox).toEqual({ x: 2, y: 2, width: 1, height: 1 });
    expect(r.margins).toEqual({ left: 2, right: 2, top: 2, bottom: 2 });
    expect(r.verdict).toBe("centered");
  });

  it("tolerance 0 demands exact symmetry, so unavoidable parity offsets fail", async () => {
    // A 3-wide subject can't sit symmetrically in a 10-wide canvas: L=3, R=4.
    const inPath = await build(10, 10, (b) => fillRect(b, 10, 3, 3, 5, 5, SOLID));
    expect((await runFramecheck({ in: inPath })).verdict).toBe("centered"); // default tol 2 absorbs the 1px parity
    const strict = await runFramecheck({ in: inPath, tolerance: 0 });
    expect(strict.deltas!.horizontal).toBe(1);
    expect(strict.verdict).toBe("offset");
  });
});
