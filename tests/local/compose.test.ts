import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseOverColor, runCompose } from "../../src/local/compose.js";

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
