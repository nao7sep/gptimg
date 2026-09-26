import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GptImg } from "../../src/index.js";

// mask's AI method is mocked so the order-of-checks test below never loads the
// real ~0.5 GB BiRefNet model or runs inference — it only needs to prove the
// producer is never called when the output already exists.
const aiMaskFromFile = vi.fn();
vi.mock("../../src/local/ai-mask.js", () => ({
  aiMaskFromFile: (...args: unknown[]) => aiMaskFromFile(...args),
}));

/**
 * Verb-level integration tests for the shared overwrite check. The pure ops
 * (runTrim / runBackplate / runLayer) don't consult --overwrite — the verb
 * impls do, via assertSingleFileAvailable in src/internal/local-verb.ts. These
 * tests prove the helper is wired into every new local verb.
 */

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

function makeOpaque(W: number, H: number, r: number, g: number, b: number): Uint8Array {
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = 255;
  }
  return rgba;
}

describe("verb-level overwrite check (assertSingleFileAvailable wiring)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-verb-overwrite-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("trim rejects an existing output without --overwrite, accepts with it", async () => {
    const sdk = new GptImg({ profileDir: tmp, logDir: tmp });
    const input = path.join(tmp, "in.png");
    await writeRawPng(input, 16, 16, makeOpaque(16, 16, 200, 0, 0));
    const out = path.join(tmp, "out.png");
    await writeFile(out, "blocker");

    await expect(
      sdk.trim({ in: input, outName: "out" }),
    ).rejects.toMatchObject({
      errorType: "localOp",
      code: "output.exists",
    });

    const res = await sdk.trim({ in: input, outName: "out", overwrite: true });
    expect(res.output).toBe(out);
  });

  it("encode rejects an existing output without --overwrite, accepts with it", async () => {
    const sdk = new GptImg({ profileDir: tmp, logDir: tmp });
    const input = path.join(tmp, "in.png");
    await writeRawPng(input, 16, 16, makeOpaque(16, 16, 200, 0, 0));
    const out = path.join(tmp, "out.webp");
    await writeFile(out, "blocker");

    await expect(
      sdk.encode({ in: input, format: "webp", outName: "out" }),
    ).rejects.toMatchObject({
      errorType: "localOp",
      code: "output.exists",
    });

    const res = await sdk.encode({ in: input, format: "webp", outName: "out", overwrite: true });
    expect(res.output).toBe(out);
  });

  it("backplate rejects an existing output without --overwrite, accepts with it", async () => {
    const sdk = new GptImg({ profileDir: tmp, logDir: tmp });
    const out = path.join(tmp, "plate.png");
    await writeFile(out, "blocker");

    await expect(
      sdk.backplate({
        size: 32,
        from: "#000000",
        to: "#ffffff",
        outDir: tmp,
        outName: "plate",
      }),
    ).rejects.toMatchObject({
      errorType: "localOp",
      code: "output.exists",
    });

    const res = await sdk.backplate({
      size: 32,
      from: "#000000",
      to: "#ffffff",
      outDir: tmp,
      outName: "plate",
      overwrite: true,
    });
    expect(res.output).toBe(out);
  });

  it("layer rejects an existing output without --overwrite, accepts with it", async () => {
    const sdk = new GptImg({ profileDir: tmp, logDir: tmp });
    const basePath = path.join(tmp, "base.png");
    const topPath = path.join(tmp, "top.png");
    await writeRawPng(basePath, 32, 32, makeOpaque(32, 32, 0, 0, 0));
    await writeRawPng(topPath, 8, 8, makeOpaque(8, 8, 255, 0, 0));
    const out = path.join(tmp, "out.png");
    await writeFile(out, "blocker");

    await expect(
      sdk.layer({ base: basePath, top: topPath, outName: "out" }),
    ).rejects.toMatchObject({
      errorType: "localOp",
      code: "output.exists",
    });

    const res = await sdk.layer({
      base: basePath,
      top: topPath,
      outName: "out",
      overwrite: true,
    });
    expect(res.output).toBe(out);
  });

  it("despeckle rejects an existing output without --overwrite, accepts with it", async () => {
    const sdk = new GptImg({ profileDir: tmp, logDir: tmp });
    const input = path.join(tmp, "in.png");
    await writeRawPng(input, 16, 16, makeOpaque(16, 16, 200, 0, 0));
    const out = path.join(tmp, "out.png");
    await writeFile(out, "blocker");

    await expect(
      sdk.despeckle({ in: input, outName: "out" }),
    ).rejects.toMatchObject({
      errorType: "localOp",
      code: "output.exists",
    });

    const res = await sdk.despeckle({ in: input, outName: "out", overwrite: true });
    expect(res.output).toBe(out);
  });

  it("mask (chroma) rejects an existing output without --overwrite, accepts with it", async () => {
    const sdk = new GptImg({ profileDir: tmp, logDir: tmp });
    const input = path.join(tmp, "in.png");
    await writeRawPng(input, 16, 16, makeOpaque(16, 16, 0, 255, 0));
    const out = path.join(tmp, "out-mask.png");
    await writeFile(out, "blocker");

    await expect(
      sdk.mask({ in: input, method: "chroma", outName: "out-mask" }),
    ).rejects.toMatchObject({
      errorType: "localOp",
      code: "output.exists",
    });

    const res = await sdk.mask({ in: input, method: "chroma", outName: "out-mask", overwrite: true });
    expect(res.output).toBe(out);
  });

  it("mask (ai) checks the output before running the mask, never loading the model for a refused overwrite", async () => {
    aiMaskFromFile.mockReset();
    const sdk = new GptImg({ profileDir: tmp, logDir: tmp });
    const input = path.join(tmp, "in.png");
    await writeRawPng(input, 16, 16, makeOpaque(16, 16, 0, 255, 0));
    const out = path.join(tmp, "out-ai-mask.png");
    await writeFile(out, "blocker");

    await expect(
      sdk.mask({ in: input, method: "ai", outName: "out-ai-mask" }),
    ).rejects.toMatchObject({
      errorType: "localOp",
      code: "output.exists",
    });
    // The regression this guards: the fix moves this check ahead of the model
    // download and inference, so a refused overwrite must never reach the
    // (mocked) AI producer at all.
    expect(aiMaskFromFile).not.toHaveBeenCalled();

    aiMaskFromFile.mockResolvedValue({
      alpha: new Uint8Array(16 * 16).fill(255),
      width: 16,
      height: 16,
      stats: { method: "ai", model: "birefnet", removedPixels: 0, removedFraction: 0, width: 16, height: 16 },
    });
    const res = await sdk.mask({ in: input, method: "ai", outName: "out-ai-mask", overwrite: true });
    expect(res.output).toBe(out);
    expect(aiMaskFromFile).toHaveBeenCalledTimes(1);
  });
});
