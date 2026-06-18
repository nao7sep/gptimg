import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseOverColor, runCompose } from "../../src/local/compose.js";
import { SRGB_TO_LINEAR_LUT, linearToSRGBByte } from "../../src/local/chroma/spill.js";

async function writeRawPng(
  filePath: string,
  width: number,
  height: number,
  rgba: Uint8Array,
): Promise<void> {
  await sharp(Buffer.from(rgba), {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toFile(filePath);
}

async function writeRawMaskPng(
  filePath: string,
  width: number,
  height: number,
  mask: Uint8Array,
): Promise<void> {
  await sharp(Buffer.from(mask), {
    raw: { width, height, channels: 1 },
  })
    .png()
    .toFile(filePath);
}

async function readRGBA(filePath: string): Promise<Uint8Array> {
  const out = await sharp(filePath).ensureAlpha().raw().toBuffer();
  return new Uint8Array(out);
}

describe("parseOverColor", () => {
  it("returns a color spec for #rrggbb", () => {
    expect(parseOverColor("#ff8000")).toEqual({
      kind: "color",
      r: 0xff,
      g: 0x80,
      b: 0x00,
    });
  });

  it("returns an image spec for non-hex values", () => {
    expect(parseOverColor("/tmp/bg.png")).toEqual({
      kind: "image",
      path: "/tmp/bg.png",
    });
  });

  it("rejects a bare 6-hex value (forgotten #) instead of treating it as a path", () => {
    expect(() => parseOverColor("aabbcc")).toThrow(/missing the leading "#"/);
  });
});

describe("runCompose", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-compose-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("writes RGBA with the mask in the alpha channel (default transparent)", async () => {
    const W = 8;
    const H = 8;
    const rgba = new Uint8Array(W * H * 4);
    for (let p = 0, i = 0; p < W * H; p++, i += 4) {
      rgba[i] = 200;
      rgba[i + 1] = 150;
      rgba[i + 2] = 50;
      rgba[i + 3] = 255;
    }
    const mask = new Uint8Array(W * H);
    for (let p = 0; p < W * H; p++) mask[p] = p < W * H / 2 ? 0 : 255;

    const inPath = path.join(tmp, "in.png");
    const maskPath = path.join(tmp, "mask.png");
    const outPath = path.join(tmp, "out.png");
    await writeRawPng(inPath, W, H, rgba);
    await writeRawMaskPng(maskPath, W, H, mask);

    await runCompose({ in: inPath, mask: maskPath, out: outPath });

    const composed = await readRGBA(outPath);
    expect(composed[3]).toBe(0);
    expect(composed[(W * H - 1) * 4 + 3]).toBe(255);
    // Fully-transparent pixels must carry no hidden RGB (clean cutout):
    // alpha-ignoring viewers should not see the original background.
    expect(composed[0]).toBe(0);
    expect(composed[1]).toBe(0);
    expect(composed[2]).toBe(0);
    // An opaque pixel keeps the source RGB.
    const last = (W * H - 1) * 4;
    expect(composed[last]).toBe(200);
    expect(composed[last + 1]).toBe(150);
    expect(composed[last + 2]).toBe(50);
  });

  it("flattens over a solid color when --over is a hex string", async () => {
    const W = 4;
    const H = 4;
    const rgba = new Uint8Array(W * H * 4);
    for (let p = 0, i = 0; p < W * H; p++, i += 4) {
      rgba[i] = 200;
      rgba[i + 1] = 0;
      rgba[i + 2] = 0;
      rgba[i + 3] = 255;
    }
    const mask = new Uint8Array(W * H).fill(0); // fully transparent → output = bg color
    const inPath = path.join(tmp, "in.png");
    const maskPath = path.join(tmp, "mask.png");
    const outPath = path.join(tmp, "out.png");
    await writeRawPng(inPath, W, H, rgba);
    await writeRawMaskPng(maskPath, W, H, mask);

    const res = await runCompose({
      in: inPath,
      mask: maskPath,
      out: outPath,
      over: { kind: "color", r: 0, g: 0, b: 255 },
    });
    expect(res.over).toBe("color");
    const composed = await readRGBA(outPath);
    expect(composed[0]).toBe(0);
    expect(composed[1]).toBe(0);
    expect(composed[2]).toBe(255);
    expect(composed[3]).toBe(255);
  });

  it("rejects a mask whose size does not match the input", async () => {
    const inPath = path.join(tmp, "in.png");
    const maskPath = path.join(tmp, "mask.png");
    const outPath = path.join(tmp, "out.png");
    const rgba = new Uint8Array(16).fill(255); // 2x2 RGBA
    const mask = new Uint8Array(9).fill(255); // 3x3 mask
    await writeRawPng(inPath, 2, 2, rgba);
    await writeRawMaskPng(maskPath, 3, 3, mask);

    await expect(
      runCompose({ in: inPath, mask: maskPath, out: outPath }),
    ).rejects.toMatchObject({ errorType: "localOp" });
  });
});

describe("runCompose — removeBleed dispatch (chromatic vs achromatic)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-compose-bleed-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function near(actual: number, expected: number, tol: number, label: string): void {
    expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tol);
  }

  /** Build a 1-row image (RGB from each pixel, alpha carried by the mask) and compose it. */
  async function buildAndCompose(
    pixels: [number, number, number, number][],
    removeBleed: string,
  ): Promise<Uint8Array> {
    const W = pixels.length;
    const H = 1;
    const rgba = new Uint8Array(W * H * 4);
    const mask = new Uint8Array(W * H);
    pixels.forEach((px, p) => {
      rgba[p * 4] = px[0];
      rgba[p * 4 + 1] = px[1];
      rgba[p * 4 + 2] = px[2];
      rgba[p * 4 + 3] = 255; // the image is opaque; alpha lives in the mask
      mask[p] = px[3];
    });
    const inPath = path.join(tmp, "in.png");
    const maskPath = path.join(tmp, "mask.png");
    const outPath = path.join(tmp, "out.png");
    await writeRawPng(inPath, W, H, rgba);
    await writeRawMaskPng(maskPath, W, H, mask);
    await runCompose({ in: inPath, mask: maskPath, out: outPath, removeBleed });
    return readRGBA(outPath);
  }

  it("chromatic PRIMARY key (green): clamps the key channel at every kept pixel (all alphas), leaves legit colors", async () => {
    // p0: green spill (g >> r,b) at FULL opacity — proving suppression hits all
    // alphas, unlike the achromatic path. p1: a legit warm colour that already
    // satisfies g <= max(r,b), so it must pass through untouched.
    const out = await buildAndCompose(
      [
        [60, 200, 60, 255],
        [200, 100, 50, 255],
      ],
      "#00ff00",
    );
    near(out[0]!, 60, 2, "p0 r untouched");
    near(out[1]!, 60, 3, "p0 g clamped to ~max(r,b)");
    near(out[2]!, 60, 2, "p0 b untouched");
    near(out[4]!, 200, 2, "p1 r unchanged");
    near(out[5]!, 100, 2, "p1 g unchanged (no clamp)");
    near(out[6]!, 50, 2, "p1 b unchanged");
  });

  it("chromatic SECONDARY key (magenta): pulls both non-suppressed channels down to the suppressed level", async () => {
    // Magenta tint: r,b high, g low → r and b reduced by their excess over g.
    const out = await buildAndCompose([[200, 40, 200, 255]], "#ff00ff");
    near(out[0]!, 40, 3, "r reduced to ~g");
    near(out[1]!, 40, 2, "g (suppressed) unchanged");
    near(out[2]!, 40, 3, "b reduced to ~g");
  });

  it("achromatic key (gray): recovers edge colour at partial-alpha, leaves alpha=255 untouched", async () => {
    // Reconstruct a captured edge pixel exactly: C = a·F + (1−a)·B in LINEAR
    // light, with F=(220,40,40), a=128/255, B=gray128 — the blend removeBleed
    // must invert. Using the same a the recovery uses makes the inversion exact
    // (bar sRGB quantization).
    const F: [number, number, number] = [220, 40, 40];
    const a = 128 / 255;
    const bLin = SRGB_TO_LINEAR_LUT[128]!;
    const captureByte = (f: number): number =>
      linearToSRGBByte(a * SRGB_TO_LINEAR_LUT[f]! + (1 - a) * bLin);
    const captured: [number, number, number, number] = [
      captureByte(220),
      captureByte(40),
      captureByte(40),
      128,
    ];
    const out = await buildAndCompose([captured, [180, 60, 60, 255]], "#808080");
    near(out[0]!, F[0], 3, "recovered r");
    near(out[1]!, F[1], 3, "recovered g");
    near(out[2]!, F[2], 3, "recovered b");
    // The recovery genuinely moved the pixel off its captured blend.
    expect(Math.abs(out[0]! - captured[0])).toBeGreaterThan(10);
    // The confidently-opaque pixel (alpha 255) is left alone by the gray path.
    near(out[4]!, 180, 2, "opaque r untouched");
    near(out[5]!, 60, 2, "opaque g untouched");
    near(out[6]!, 60, 2, "opaque b untouched");
  });
});
