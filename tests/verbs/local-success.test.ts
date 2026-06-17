import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GptImg } from "../../src/index.js";

/**
 * Success-path integration tests for the local SDK verbs, exercised through the
 * public GptImg facade. The pure ops in src/local/* are already covered; this
 * file covers the verb-orchestration wrappers in src/verbs/* — option
 * resolution, default output naming, and output writing — for the local verbs
 * that need no model files. Each test builds a real input, runs the verb, and
 * asserts a concrete property of the produced file (not just "did not throw").
 *
 * AI/model paths (upscale, mask --method ai) are deliberately excluded; they
 * require ONNX weights and are tested separately.
 */

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

async function writeMaskPng(
  filePath: string,
  width: number,
  height: number,
  values: number[],
): Promise<void> {
  await sharp(Buffer.from(Uint8Array.from(values)), {
    raw: { width, height, channels: 1 },
  })
    .png()
    .toFile(filePath);
}

/** A square master PNG of the given size (icon needs >= 1024 square). */
async function writeSquare(
  filePath: string,
  size: number,
  rgb: [number, number, number] = [60, 90, 200],
): Promise<void> {
  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha: 1 },
    },
  })
    .png()
    .toFile(filePath);
}

/** Transparent canvas with an opaque red center block (alpha to preserve). */
function diskish(W: number, H: number): Uint8Array {
  const rgba = new Uint8Array(W * H * 4);
  const x0 = Math.floor(W * 0.3), x1 = Math.ceil(W * 0.7);
  const y0 = Math.floor(H * 0.3), y1 = Math.ceil(H * 0.7);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      rgba[i] = 220; rgba[i + 1] = 40; rgba[i + 2] = 40; rgba[i + 3] = 255;
    }
  }
  return rgba;
}

/** Pure-green field with an opaque yellow subject block — chroma keyable. */
function greenWithSubject(W: number, H: number): Uint8Array {
  const rgba = new Uint8Array(W * H * 4);
  for (let p = 0, i = 0; p < W * H; p++, i += 4) {
    rgba[i] = 0; rgba[i + 1] = 255; rgba[i + 2] = 0; rgba[i + 3] = 255;
  }
  const x0 = Math.floor(W * 0.33), x1 = Math.ceil(W * 0.66);
  const y0 = Math.floor(H * 0.33), y1 = Math.ceil(H * 0.66);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      rgba[i] = 220; rgba[i + 1] = 200; rgba[i + 2] = 60; rgba[i + 3] = 255;
    }
  }
  return rgba;
}

describe("local verbs success path (via GptImg SDK)", () => {
  let tmp: string;
  let sdk: GptImg;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-local-success-"));
    sdk = new GptImg({ profileDir: tmp, logDir: tmp });
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("resize: writes the named output at the resolved dimensions", async () => {
    const input = path.join(tmp, "in.png");
    await writeRawPng(input, 100, 50, diskish(100, 50));

    const res = await sdk.resize({ in: input, toSize: 50, outName: "out" });

    const out = path.join(tmp, "out.png");
    expect(res.output).toBe(out);
    expect(existsSync(out)).toBe(true);
    // toSize is the longer side; aspect preserved (100x50 -> 50x25).
    expect(res.width).toBe(50);
    expect(res.height).toBe(25);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(50);
    expect(meta.height).toBe(25);
    expect(meta.format).toBe("png");
  });

  it("shadow: writes the named output keeping the input canvas size", async () => {
    const input = path.join(tmp, "in.png");
    await writeRawPng(input, 128, 128, diskish(128, 128));

    const res = await sdk.shadow({ in: input, outName: "out", keepCanvas: true });

    const out = path.join(tmp, "out.png");
    expect(res.output).toBe(out);
    expect(existsSync(out)).toBe(true);
    // keepCanvas → output matches the source dimensions.
    expect(res.width).toBe(128);
    expect(res.height).toBe(128);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(128);
    expect(meta.height).toBe(128);
    expect(meta.hasAlpha).toBe(true);
  });

  it("combine: unions two masks into the named output", async () => {
    const a = path.join(tmp, "a.png");
    const b = path.join(tmp, "b.png");
    await writeMaskPng(a, 2, 1, [10, 200]);
    await writeMaskPng(b, 2, 1, [50, 100]);

    const res = await sdk.combine({ op: "union", inputs: [a, b], outName: "out" });

    const out = path.join(tmp, "out.png");
    expect(res.output).toBe(out);
    expect(existsSync(out)).toBe(true);
    expect(res.op).toBe("union");
    expect(res.width).toBe(2);
    expect(res.height).toBe(1);
    // union = pixelwise max.
    const got = await sharp(out).grayscale().removeAlpha().raw().toBuffer();
    expect(Array.from(new Uint8Array(got))).toEqual([50, 200]);
  });

  it("compose: applies the mask as alpha into the named output", async () => {
    const W = 8, H = 8;
    const rgba = new Uint8Array(W * H * 4);
    for (let p = 0, i = 0; p < W * H; p++, i += 4) {
      rgba[i] = 200; rgba[i + 1] = 150; rgba[i + 2] = 50; rgba[i + 3] = 255;
    }
    const mask = new Uint8Array(W * H);
    for (let p = 0; p < W * H; p++) mask[p] = p < (W * H) / 2 ? 0 : 255;

    const inPath = path.join(tmp, "in.png");
    const maskPath = path.join(tmp, "mask.png");
    await writeRawPng(inPath, W, H, rgba);
    await writeMaskPng(maskPath, W, H, Array.from(mask));

    const res = await sdk.compose({ in: inPath, mask: maskPath, outName: "out" });

    const out = path.join(tmp, "out.png");
    expect(res.output).toBe(out);
    expect(existsSync(out)).toBe(true);
    expect(res.width).toBe(W);
    expect(res.height).toBe(H);
    expect(res.over).toBe("transparent");
    // First pixel masked out (alpha 0), last pixel kept (alpha 255, source RGB).
    const composed = new Uint8Array(await sharp(out).ensureAlpha().raw().toBuffer());
    expect(composed[3]).toBe(0);
    const last = (W * H - 1) * 4;
    expect(composed[last + 3]).toBe(255);
    expect(composed[last]).toBe(200);
  });

  it("icon: writes icns, ico and png from a 1024 master", async () => {
    const master = path.join(tmp, "master.png");
    await writeSquare(master, 1024);

    const res = await sdk.icon({ in: master, outDir: tmp, name: "app" });

    expect(res.outputs).toEqual([res.icns, res.ico, res.png]);
    expect(res.icns).toBe(path.join(tmp, "app.icns"));
    expect(res.ico).toBe(path.join(tmp, "app.ico"));
    expect(res.png).toBe(path.join(tmp, "app.png"));
    for (const f of res.outputs) expect(existsSync(f)).toBe(true);
    expect(res.width).toBe(1024);
    // The .icns has the "icns" magic and a self-consistent total length.
    const icns = await readFile(res.icns);
    expect(icns.toString("ascii", 0, 4)).toBe("icns");
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    const pngMeta = await sharp(res.png).metadata();
    expect(pngMeta.width).toBe(1024);
  });

  it("mask (chroma): removes the green field and writes the named mask", async () => {
    const W = 48, H = 48;
    const input = path.join(tmp, "in.png");
    await writeRawPng(input, W, H, greenWithSubject(W, H));

    const res = await sdk.mask({ in: input, method: "chroma", key: "#00ff00", outName: "out" });

    const out = path.join(tmp, "out.png");
    expect(res.output).toBe(out);
    expect(existsSync(out)).toBe(true);
    expect(res.stats.method).toBe("chroma");
    if (res.stats.method === "chroma") {
      expect(res.stats.key).toBe("#00ff00");
      // Most of the frame is green background → removed.
      expect(res.stats.removedFraction).toBeGreaterThan(0.5);
    }
    // The written mask is a single-channel grayscale PNG (0 = removed,
    // 255 = kept). Green border pixels -> 0, subject center -> 255.
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(W);
    expect(meta.height).toBe(H);
    const data = new Uint8Array(await sharp(out).grayscale().removeAlpha().raw().toBuffer());
    expect(data[0]).toBe(0); // corner = background = removed
    const center = Math.floor(H / 2) * W + Math.floor(W / 2);
    expect(data[center]).toBe(255); // subject kept
  });
});
