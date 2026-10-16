import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dilateAlpha, runShadow } from "../../src/local/shadow.js";

/** A centered opaque square on a transparent canvas. */
async function writeCenteredSquare(
  filePath: string,
  canvas: number,
  square: number,
  rgb: [number, number, number] = [200, 60, 60],
): Promise<void> {
  const inset = Math.round((canvas - square) / 2);
  const fill = await sharp({
    create: {
      width: square,
      height: square,
      channels: 4,
      background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  await sharp({
    create: {
      width: canvas,
      height: canvas,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: fill, left: inset, top: inset }])
    .png()
    .toFile(filePath);
}

describe("runShadow", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-shadow-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("grows the canvas to fit an offset, blurred shadow by default", async () => {
    const src = path.join(tmp, "src.png");
    await writeCenteredSquare(src, 256, 128);
    const out = path.join(tmp, "out.png");

    const res = await runShadow({ in: src, out, offset: { x: 0, y: 8 }, blur: 12 });
    expect(res.sourceWidth).toBe(256);
    expect(res.keepCanvas).toBe(false);
    // pad = spread(0) + ceil(3*12)=36; shadow offset +8 down → canvas grows.
    expect(res.width).toBeGreaterThan(256);
    expect(res.height).toBeGreaterThan(256);

    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(res.width);
    expect(meta.height).toBe(res.height);
    expect(meta.format).toBe("png");
    expect(meta.hasAlpha).toBe(true);
  });

  it("keeps the input dimensions when keepCanvas is set", async () => {
    const src = path.join(tmp, "src.png");
    await writeCenteredSquare(src, 256, 128);
    const out = path.join(tmp, "out.png");

    const res = await runShadow({ in: src, out, keepCanvas: true });
    expect(res.width).toBe(256);
    expect(res.height).toBe(256);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(256);
    expect(meta.height).toBe(256);
  });

  it("normalizes the color and echoes resolved params", async () => {
    const src = path.join(tmp, "src.png");
    await writeCenteredSquare(src, 128, 64);
    const out = path.join(tmp, "out.png");

    const res = await runShadow({
      in: src,
      out,
      color: "#1A2B3C",
      opacity: 0.5,
      spread: 4,
      blur: 6,
    });
    expect(res.color).toBe("#1a2b3c");
    expect(res.opacity).toBe(0.5);
    expect(res.spread).toBe(4);
    expect(res.blur).toBe(6);
  });

  it("renders a darker region where the shadow falls, in keepCanvas mode", async () => {
    const src = path.join(tmp, "src.png");
    // Small square high in the frame so the downward shadow lands on transparency.
    await writeCenteredSquare(src, 256, 64);
    const out = path.join(tmp, "out.png");

    await runShadow({
      in: src,
      out,
      keepCanvas: true,
      offset: { x: 0, y: 40 },
      blur: 8,
      opacity: 0.6,
    });

    // Sample a band below the subject: it should have nonzero alpha (shadow),
    // whereas the original transparent canvas there had alpha 0.
    const { data, info } = await sharp(out)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const x = Math.floor(info.width / 2);
    const y = Math.floor(info.height / 2) + 50; // below the centered square
    const alpha = data[(y * info.width + x) * 4 + 3]!;
    expect(alpha).toBeGreaterThan(0);
  });

  // Argument-bound rejections (opacity, spread, offset, blur ranges) now live in
  // verbs/schemas.ts and are covered by tests/verbs/schemas.test.ts. runShadow
  // trusts the validated args it is handed.
  it("accepts blur 0 as 'no blur'", async () => {
    const src = path.join(tmp, "src.png");
    await writeCenteredSquare(src, 64, 32);
    const res = await runShadow({ in: src, out: path.join(tmp, "ok.png"), blur: 0 });
    expect(res.blur).toBe(0);
  });
});

describe("dilateAlpha", () => {
  /** Square dilation by direct window maxima, the definition the fast path must match. */
  function reference(src: Uint8Array, width: number, height: number, r: number): Uint8Array {
    const out = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let m = 0;
        for (let yy = Math.max(0, y - r); yy <= Math.min(height - 1, y + r); yy++) {
          for (let xx = Math.max(0, x - r); xx <= Math.min(width - 1, x + r); xx++) {
            m = Math.max(m, src[yy * width + xx]!);
          }
        }
        out[y * width + x] = m;
      }
    }
    return out;
  }

  it("matches direct window maxima for radii below, at and beyond the image size", () => {
    let seed = 7;
    const random = (): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % 256;
    for (const [width, height] of [[1, 1], [9, 4], [13, 17]] as const) {
      const src = Uint8Array.from({ length: width * height }, () => (random() < 230 ? 0 : random()));
      for (const r of [1, 2, 3, 6, 16, 40]) {
        expect(Array.from(dilateAlpha(src, width, height, r)), `${width}x${height} r=${r}`).toEqual(
          Array.from(reference(src, width, height, r)),
        );
      }
    }
  });

  it("returns the input unchanged for a zero radius", () => {
    const src = Uint8Array.from([0, 9, 0]);
    expect(dilateAlpha(src, 3, 1, 0)).toBe(src);
  });
});
