// The SDK end to end through its public class, with nothing substituted: the
// pinned background-removal and upscaling models, fetched through the SDK's own
// installer, and the real OpenAI API. Run only by npm run test:full, through
// vitest.live.config.ts.
//
// The models live in a cache that persists between runs (GPTIMG_MODELS_DIR, the
// SDK's own relocation seam) and follow its rule: install what is missing, and
// replace a model only when a new pin names a new file. Each test runs on a
// throwaway profile whose profile.json names OPENAI_API_KEY and stores no key.

import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GptImg } from "../../src/index.js";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const CACHE = join(REPO, "node_modules", ".cache", "gptimg-live");
const MODELS = join(CACHE, "models");
const CORPUS = join(REPO, "..", "company", "assets", "test-fixtures");
// A red disc of radius 30 centred on a noisy green backdrop, 128 x 128.
const DISC = join(REPO, "tests", "fixtures", "green-disk.png");
const CAT_PHOTO = "photos/similarity/apartment-cat/reference.jpg";
// The lane proves the code paths, not image quality, so every paid call asks for
// the cheapest output the provider offers.
const CHEAPEST_IMAGE = { quality: "low", size: "1024x1024" };
const CHEAPEST_VISION = { detail: "low" as const };

process.env.GPTIMG_MODELS_DIR = MODELS;

const homes: string[] = [];

/** A GptImg on a throwaway profile that resolves its key from OPENAI_API_KEY only. */
async function freshSdk(label: string): Promise<{ img: GptImg; home: string }> {
  const home = await mkdtemp(join(CACHE, `${label}-`));
  homes.push(home);
  await writeFile(join(home, "profile.json"), `${JSON.stringify({ provider: "openai", apiKeyEnv: "OPENAI_API_KEY" })}\n`);
  return { img: new GptImg({ profileDir: home }), home };
}

function requireKey(): void {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("OPENAI_API_KEY is not set. The full run calls the real OpenAI API; export OPENAI_API_KEY and run it again.");
  }
}

async function copyInto(home: string, source: string): Promise<string> {
  const copy = join(home, basename(source));
  await copyFile(source, copy).catch(() => {
    throw new Error(`Cannot read ${source}. The vision test reads the shared test-fixture corpus; check out the company repository beside this one.`);
  });
  return copy;
}

/** The request a sidecar records, which proves what reached the provider. */
async function sentRequest(sidecarPath: string): Promise<Record<string, unknown>> {
  return (JSON.parse(await readFile(sidecarPath, "utf8")) as { request: Record<string, unknown> }).request;
}

/** Mean RGB over the centred square covering `fraction` of each side. */
async function centreColour(file: string, fraction: number): Promise<{ r: number; g: number; b: number }> {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const side = Math.round(Math.min(info.width, info.height) * fraction);
  const left = Math.floor((info.width - side) / 2);
  const top = Math.floor((info.height - side) / 2);
  const sum = { r: 0, g: 0, b: 0 };
  for (let y = top; y < top + side; y++) {
    for (let x = left; x < left + side; x++) {
      const i = (y * info.width + x) * info.channels;
      sum.r += data[i]!;
      sum.g += data[i + 1]!;
      sum.b += data[i + 2]!;
    }
  }
  const count = side * side;
  return { r: sum.r / count, g: sum.g / count, b: sum.b / count };
}

/** The single-channel value at (x, y) of a mask PNG. */
async function maskValue(file: string, x: number, y: number): Promise<number> {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  return data[(y * info.width + x) * info.channels]!;
}

beforeAll(async () => {
  await mkdir(MODELS, { recursive: true });
  const { img } = await freshSdk("install");
  await img.model.installAll();
});

afterAll(async () => {
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
});

describe("the live SDK", () => {
  it("has every pinned model installed and matching its pinned digest", async () => {
    const { img } = await freshSdk("verify");
    for (const model of img.model.list().models) expect(model.cached, model.name).toBe(true);
    const { models } = await img.model.verify();
    for (const model of models) expect(model.integrity, model.name).toBe("ok");
  });

  it("cuts the subject out of a test image with the pinned BiRefNet", async () => {
    const { img, home } = await freshSdk("mask");
    const result = await img.mask({ in: await copyInto(home, DISC), method: "ai", outDir: home });
    expect(result.stats).toMatchObject({ method: "ai", model: "birefnet", width: 128, height: 128 });
    expect(await maskValue(result.output!, 64, 64), "the disc is kept").toBeGreaterThan(200);
    for (const [x, y] of [[4, 4], [123, 4], [4, 123], [123, 123]] as const) {
      expect(await maskValue(result.output!, x, y), `the backdrop at ${x},${y} is removed`).toBeLessThan(55);
    }
  });

  it("enlarges a test image with the pinned Swin2SR", async () => {
    const { img, home } = await freshSdk("upscale");
    const result = await img.upscale({ in: await copyInto(home, DISC), outDir: home });
    expect(result).toMatchObject({ sourceWidth: 128, modelWidth: 512, width: 1024, height: 1024 });
    expect(await sharp(result.output).metadata()).toMatchObject({ width: 1024, height: 1024 });
    const centre = await centreColour(result.output, 0.2);
    expect(centre.r, "the disc stays red").toBeGreaterThan(centre.g + 80);
  });

  it("generates an image through the real OpenAI API", async () => {
    requireKey();
    const { img, home } = await freshSdk("generate");
    const result = await img.generate({
      prompt: "A single flat solid red circle centred on a plain white background. No shading, texture, or other objects.",
      outDir: home,
      overrides: { generate: CHEAPEST_IMAGE },
    });
    expect(result.partial).toBe(false);
    expect(result.files).toHaveLength(1);
    const [file] = result.files;
    expect(await sentRequest(file!.sidecarPath)).toMatchObject(CHEAPEST_IMAGE);
    expect((await sharp(file!.path).metadata()).format).toBe(file!.format);
    const centre = await centreColour(file!.path, 0.2);
    expect(centre.r, "the centre is red").toBeGreaterThan(centre.g + 80);
  });

  it("edits an image through the real OpenAI API", async () => {
    requireKey();
    const { img, home } = await freshSdk("edit");
    const result = await img.edit({
      in: await copyInto(home, DISC),
      prompt: "Recolour the red disc pure blue. Keep its size and position and keep the green background unchanged.",
      outDir: home,
      overrides: { edit: CHEAPEST_IMAGE },
    });
    expect(result.files).toHaveLength(1);
    const [file] = result.files;
    expect(await sentRequest(file!.sidecarPath)).toMatchObject(CHEAPEST_IMAGE);
    const centre = await centreColour(file!.path, 0.2);
    expect(centre.b, "the disc is now blue").toBeGreaterThan(centre.r + 80);
  });

  it("judges a corpus photo through the real OpenAI vision model", async () => {
    requireKey();
    const { img, home } = await freshSdk("vision");
    const photo = await copyInto(home, join(CORPUS, CAT_PHOTO));
    const holds = await img.vision({
      in: photo,
      check: "A cat is visible in the image.",
      outDir: home,
      overrides: { vision: CHEAPEST_VISION },
    });
    expect(holds.ok, holds.reasons.join(" ")).toBe(true);
    expect(await sentRequest(holds.sidecarPath)).toMatchObject(CHEAPEST_VISION);
    const fails = await img.vision({
      in: photo,
      check: "A dog is visible in the image.",
      outDir: home,
      outName: "dog-check",
      overrides: { vision: CHEAPEST_VISION },
    });
    expect(fails.ok, fails.reasons.join(" ")).toBe(false);
  });
});
