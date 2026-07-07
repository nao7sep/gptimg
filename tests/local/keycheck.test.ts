import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hueDistance, rgbToHsv, runKeycheck } from "../../src/local/keycheck.js";

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

async function readRGBA(filePath: string): Promise<{
  data: Uint8Array;
  width: number;
  height: number;
}> {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

function blank(W: number, H: number): Uint8Array {
  return new Uint8Array(W * H * 4);
}
function setPx(
  buf: Uint8Array,
  W: number,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  const i = (y * W + x) * 4;
  buf[i] = r;
  buf[i + 1] = g;
  buf[i + 2] = b;
  buf[i + 3] = a;
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
    for (let x = x0; x <= x1; x++) setPx(buf, W, x, y, rgba[0], rgba[1], rgba[2], rgba[3]);
}
function pxAt(
  img: { data: Uint8Array; width: number },
  x: number,
  y: number,
): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!];
}

const GREEN = "#00ff00";
const MAGENTA = "#ff00ff";
const BLUE: [number, number, number, number] = [40, 80, 200, 255]; // hue ~225, far from green/magenta
const PURE_GREEN: [number, number, number, number] = [0, 255, 0, 255];
const FRINGE_GREEN: [number, number, number, number] = [30, 210, 30, 255]; // hue 120, high sat

describe("rgbToHsv / hueDistance — the principled colour math", () => {
  it("resolves the primary/secondary hues exactly", () => {
    expect(rgbToHsv(255, 0, 0).h).toBe(0);
    expect(rgbToHsv(0, 255, 0).h).toBe(120);
    expect(rgbToHsv(0, 0, 255).h).toBe(240);
    expect(rgbToHsv(255, 255, 0).h).toBe(60);
    expect(rgbToHsv(0, 255, 255).h).toBe(180);
    expect(rgbToHsv(255, 0, 255).h).toBe(300); // magenta: both max channels agree
  });

  it("reports an achromatic pixel as zero saturation and NaN hue", () => {
    const gray = rgbToHsv(128, 128, 128);
    expect(gray.s).toBe(0);
    expect(Number.isNaN(gray.h)).toBe(true);
    const black = rgbToHsv(0, 0, 0);
    expect(black.v).toBe(0);
    expect(black.s).toBe(0);
  });

  it("measures hue distance on the circle (wraps at 360, max 180)", () => {
    expect(hueDistance(350, 10)).toBe(20);
    expect(hueDistance(10, 350)).toBe(20);
    expect(hueDistance(120, 120)).toBe(0);
    expect(hueDistance(120, 300)).toBe(180);
    expect(hueDistance(120, 180)).toBe(60);
  });
});

describe("runKeycheck", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-keycheck-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function build(W: number, H: number, paint: (buf: Uint8Array) => void): Promise<string> {
    const buf = blank(W, H);
    paint(buf);
    const p = path.join(tmp, `in-${Math.floor(W * 1000 + H)}-${paint.length}.png`);
    await writeRawPng(p, W, H, buf);
    return p;
  }

  it("reports a clean cutout (non-key subject) as zero residue → verdict clean", async () => {
    const W = 10, H = 10;
    const inPath = await build(W, H, (b) => fillRect(b, W, 3, 3, 6, 6, BLUE)); // 4x4 blue island
    const res = await runKeycheck({ in: inPath, key: GREEN });
    expect(res.presentPixels).toBe(16);
    expect(res.residuePixels).toBe(0);
    expect(res.edgeResiduePixels).toBe(0);
    expect(res.interiorResiduePixels).toBe(0);
    expect(res.edgeResidueFraction).toBe(0);
    expect(res.worstBBox).toBeNull();
    expect(res.verdict).toBe("clean");
    // The 4x4 island has a 12-pixel edge ring (inner 2x2 are interior).
    expect(res.edgePixels).toBe(12);
  });

  it("flags a green fringe ring on the alpha edge → high edge fraction, verdict residue", async () => {
    const W = 12, H = 12;
    // 6x6 island: green outer ring (fringe), blue 4x4 core.
    const inPath = await build(W, H, (b) => {
      fillRect(b, W, 3, 3, 8, 8, FRINGE_GREEN);
      fillRect(b, W, 4, 4, 7, 7, BLUE);
    });
    const res = await runKeycheck({ in: inPath, key: GREEN });
    expect(res.presentPixels).toBe(36);
    expect(res.residuePixels).toBe(20); // the 20-pixel green ring
    expect(res.edgePixels).toBe(20); // exactly the ring borders transparency
    expect(res.edgeResiduePixels).toBe(20);
    expect(res.interiorResiduePixels).toBe(0);
    expect(res.edgeResidueFraction).toBe(1);
    expect(res.verdict).toBe("residue");
    expect(res.worstBBox).toEqual({ x: 3, y: 3, width: 6, height: 6 });
  });

  it("does NOT flag a key-ADJACENT subject hue outside the tolerance (no false positive)", async () => {
    const W = 8, H = 8;
    // Spring green (0,255,128): hue ~150, 30° off the green key — a green-ish
    // subject the keyer never touched. Default tolerance 20 must exclude it.
    const inPath = await build(W, H, (b) => fillRect(b, W, 2, 2, 5, 5, [0, 255, 128, 255]));
    const res = await runKeycheck({ in: inPath, key: GREEN });
    expect(res.residuePixels).toBe(0);
    expect(res.verdict).toBe("clean");
  });

  it("does NOT flag a low-saturation pixel AT the key hue (saturation gate)", async () => {
    const W = 8, H = 8;
    // (120,140,120): hue exactly 120 but saturation ~0.14 — a near-gray the hue
    // alone would falsely catch; the saturation gate excludes it.
    const inPath = await build(W, H, (b) => fillRect(b, W, 2, 2, 5, 5, [120, 140, 120, 255]));
    expect(rgbToHsv(120, 140, 120).h).toBe(120);
    const res = await runKeycheck({ in: inPath, key: GREEN });
    expect(res.residuePixels).toBe(0);
    expect(res.verdict).toBe("clean");
  });

  it("flags an un-keyed interior background patch (no alpha edge involved)", async () => {
    const W = 10, H = 10;
    // Fully opaque canvas (no transparency anywhere → no edge pixels), mostly
    // blue, with a 3x3 pure-green block the keyer missed in the interior.
    const inPath = await build(W, H, (b) => {
      fillRect(b, W, 0, 0, 9, 9, BLUE);
      fillRect(b, W, 4, 4, 6, 6, PURE_GREEN);
    });
    const res = await runKeycheck({ in: inPath, key: GREEN });
    expect(res.presentPixels).toBe(100);
    expect(res.edgePixels).toBe(0); // nothing borders transparency
    expect(res.residuePixels).toBe(9);
    expect(res.edgeResiduePixels).toBe(0);
    expect(res.interiorResiduePixels).toBe(9);
    expect(res.edgeResidueFraction).toBe(0);
    expect(res.verdict).toBe("residue"); // interior residue alone fails the verdict
    expect(res.worstBBox).toEqual({ x: 4, y: 4, width: 3, height: 3 });
  });

  it("respects the key hue: a green subject is clean under a MAGENTA key", async () => {
    const W = 8, H = 8;
    const inPath = await build(W, H, (b) => fillRect(b, W, 2, 2, 5, 5, PURE_GREEN));
    const res = await runKeycheck({ in: inPath, key: MAGENTA });
    expect(res.residuePixels).toBe(0);
    expect(res.verdict).toBe("clean");
  });

  it("honours the tolerance boundary (≤ includes, just beyond excludes)", async () => {
    const W = 8, H = 8;
    // Pure cyan subject: hue exactly 180, distance 60 from the green key.
    const inPath = await build(W, H, (b) => fillRect(b, W, 2, 2, 5, 5, [0, 255, 255, 255]));
    const included = await runKeycheck({ in: inPath, key: GREEN, hueTolerance: 60 });
    expect(included.residuePixels).toBe(16);
    const excluded = await runKeycheck({ in: inPath, key: GREEN, hueTolerance: 59 });
    expect(excluded.residuePixels).toBe(0);
  });

  it("writes a heatmap: edge residue red, interior residue orange, clean subject gray", async () => {
    const W = 12, H = 12;
    // Green ring (edge residue) + a deliberate interior green pixel + blue core.
    const inPath = await build(W, H, (b) => {
      fillRect(b, W, 3, 3, 8, 8, FRINGE_GREEN);
      fillRect(b, W, 4, 4, 7, 7, BLUE);
      setPx(b, W, 5, 5, 0, 255, 0, 255); // an interior pixel that is pure key
    });
    const heatmapOut = path.join(tmp, "heat.png");
    const res = await runKeycheck({ in: inPath, key: GREEN, heatmapOut });
    expect(res.heatmapPath).toBe(heatmapOut);
    const heat = await readRGBA(heatmapOut);
    expect(pxAt(heat, 3, 3)).toEqual([255, 0, 0, 255]); // ring corner: edge residue → red
    expect(pxAt(heat, 5, 5)).toEqual([255, 128, 0, 255]); // interior key pixel → orange
    expect(pxAt(heat, 4, 4)).toEqual([90, 90, 90, 110]); // blue core: clean present → gray
    expect(pxAt(heat, 0, 0)).toEqual([0, 0, 0, 0]); // background → transparent
  });

  it("treats a fully-transparent image as clean (no present pixels)", async () => {
    const W = 6, H = 6;
    const inPath = await build(W, H, () => {});
    const res = await runKeycheck({ in: inPath, key: GREEN });
    expect(res.presentPixels).toBe(0);
    expect(res.edgePixels).toBe(0);
    expect(res.residuePixels).toBe(0);
    expect(res.edgeResidueFraction).toBe(0);
    expect(res.residueFraction).toBe(0);
    expect(res.worstBBox).toBeNull();
    expect(res.verdict).toBe("clean");
  });

  it("rejects an achromatic key (no hue to scan toward)", async () => {
    const W = 4, H = 4;
    const inPath = await build(W, H, (b) => fillRect(b, W, 1, 1, 2, 2, BLUE));
    await expect(runKeycheck({ in: inPath, key: "#808080" })).rejects.toThrow(/achromatic/);
  });

  it("does NOT flag a DARK pixel at the key hue (value gate), but does once minValue drops below it", async () => {
    const W = 8, H = 8;
    // (0,50,0): hue exactly 120, saturation 1.0, but value ≈ 0.196 — a near-black
    // green the hue+saturation alone would catch; the value gate (default 0.25) excludes it.
    const inPath = await build(W, H, (b) => fillRect(b, W, 2, 2, 5, 5, [0, 50, 0, 255]));
    expect(rgbToHsv(0, 50, 0).h).toBe(120);
    const gated = await runKeycheck({ in: inPath, key: GREEN });
    expect(gated.residuePixels).toBe(0);
    expect(gated.verdict).toBe("clean");
    // Drop the value gate below this pixel's value and it IS caught — proving the
    // exclusion was the value gate, not the hue or saturation.
    const caught = await runKeycheck({ in: inPath, key: GREEN, minValue: 0.1 });
    expect(caught.residuePixels).toBe(16);
  });

  it("the verdict knobs decide pass/fail at fixed pixels (maxEdgeResidueFraction / maxInteriorResiduePixels)", async () => {
    const W = 12, H = 12;
    // A green fringe ring (edgeResidueFraction = 1.0) over a blue core.
    const ring = await build(W, H, (b) => {
      fillRect(b, W, 3, 3, 8, 8, FRINGE_GREEN);
      fillRect(b, W, 4, 4, 7, 7, BLUE);
    });
    expect((await runKeycheck({ in: ring, key: GREEN })).verdict).toBe("residue"); // default 0.02
    const lenient = await runKeycheck({ in: ring, key: GREEN, maxEdgeResidueFraction: 1 });
    expect(lenient.edgeResidueFraction).toBe(1);
    expect(lenient.verdict).toBe("clean"); // same pixels, fringe now tolerated

    // A 3×3 interior patch on a fully-opaque canvas → 9 interior residue, no edge.
    const patch = await build(W, H, (b) => {
      fillRect(b, W, 0, 0, 11, 11, BLUE);
      fillRect(b, W, 5, 5, 7, 7, PURE_GREEN);
    });
    expect((await runKeycheck({ in: patch, key: GREEN })).verdict).toBe("residue"); // default max 0
    const tolerated = await runKeycheck({ in: patch, key: GREEN, maxInteriorResiduePixels: 9 });
    expect(tolerated.interiorResiduePixels).toBe(9);
    expect(tolerated.verdict).toBe("clean"); // budget now covers the patch
  });
});
