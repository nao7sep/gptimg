// The SDK end to end through its public class, with nothing substituted: the
// pinned background-removal and upscaling models, fetched through the SDK's own
// installer, and the real OpenAI API. Run only by npm run test:full, through
// vitest.live.config.ts.
//
// The models live in a folder that persists between runs, passed as each
// instance's modelsDir, and follow the SDK's rule: install explicitly what is
// missing, and replace a model only when a new pin names a new file. The key
// comes from OPENAI_API_KEY, which the test reads and passes as apiKey; the SDK
// reads no environment itself. The SDK writes no log, so the lane keeps each
// call's events in its folder's events.jsonl, as a script would. A failed test
// keeps its folder (outputs, sidecars, events) for diagnosis until the next
// live run starts; a passed test's folder is removed.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from "vitest";

import { SUPPORTED_MODELS, type ImageModelRow, type VisionModelRow } from "../../src/ai-models.ts";
import { GptImg } from "../../src/index.ts";
import type { SdkEvent, VerbCallOptions } from "../../src/index.ts";
import { done } from "../helpers/results.ts";

const PACKAGE = fileURLToPath(new URL("../../", import.meta.url));
const CACHE = join(PACKAGE, "node_modules", ".cache", "gptimgsdklive");
const MODELS = join(CACHE, "models");
// The shared corpus is the company repository's, checked out beside the repository
// that holds this package: found by walking up, so the lane runs the same from the
// app's repository or from a repository of the SDK's own.
const CORPUS = corpusDir();

function corpusDir(): string {
  for (let dir = PACKAGE; ; dir = dirname(dir)) {
    const candidate = join(dir, "company", "assets", "test-fixtures");
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return join(dirname(dirname(PACKAGE)), "company", "assets", "test-fixtures");
  }
}
// A red disc of radius 30 centred on a noisy green backdrop, 128 x 128.
const DISC = join(PACKAGE, "tests", "fixtures", "green-disk.png");
const CAT_PHOTO = "photos/similarity/apartment-cat/reference.jpg";
// The lane proves the code paths, not image quality, so every paid call asks for
// the cheapest output the provider offers: the lowest quality and the smallest size
// the image rows' size rule allows (655,360 pixels).
const CHEAPEST_IMAGE = { quality: "low", size: "1024x640" };
const CHEAPEST_VISION = { detail: "low" as const };
const IMAGE_MODELS = SUPPORTED_MODELS.filter((row): row is ImageModelRow => "image" in row).map((row) => row.id);
const VISION_ROWS = SUPPORTED_MODELS.filter((row): row is VisionModelRow => "thinking" in row);
// Models the vision guide does not list as honouring `detail`, checked against the real API.
const DETAIL_CHECKED_VISION_MODELS = ["gpt-6-luna", "gpt-6.1-sol"] as const;

const homes: string[] = [];
const keptHomes = new Set<string>();

/**
 * A GptImg with the key from OPENAI_API_KEY and the lane's models folder, whose
 * verb calls append every event they receive to the test folder's events.jsonl.
 */
async function freshSdk(label: string): Promise<{ img: GptImg; home: string }> {
  const home = await mkdtemp(join(CACHE, `${label}-`));
  homes.push(home);
  // Inside a test, a failure keeps this folder; the install step in beforeAll has no test.
  if (expect.getState().currentTestName !== undefined) onTestFailed(() => void keptHomes.add(home));
  const apiKey = process.env.OPENAI_API_KEY?.trim() || undefined;
  const sdk = new GptImg({ apiKey, modelsDir: MODELS, debug: true, caller: { name: "gptimgsdklive", version: "1" } });
  const record = (event: SdkEvent): void => appendFileSync(join(home, "events.jsonl"), `${JSON.stringify(event)}\n`);
  const img = new Proxy(sdk, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (args: unknown, opts: VerbCallOptions = {}) =>
        (value as (a: unknown, o: VerbCallOptions) => unknown).call(target, args, {
          ...opts,
          onEvent: (event: SdkEvent) => {
            record(event);
            opts.onEvent?.(event);
          },
        });
    },
  });
  return { img, home };
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

interface ImageSidecar {
  format: { owner: string; kind: string; version: number };
  writer: { name: string; version: string; caller?: { name: string; version: string } };
  operation: string;
  request: Record<string, unknown>;
  response: { created?: unknown; usage?: unknown; data?: Array<{ b64_json?: unknown }> };
  files: Array<{ index: number; name: string; sha256: string; format: string }>;
}

/**
 * A sidecar is the image's whole record: the settings and prompt that were sent, the
 * provider's reply with its time and usage but without the image bytes the file holds,
 * and the file it describes by name, digest and format. It never holds the key.
 */
async function expectCompleteImageSidecar(
  file: { path: string; sidecarPath: string; sha256: string; format: string; sidecar: { status: string }; record: unknown },
  request: Record<string, unknown>,
  kind: "generate" | "edit" = "generate",
): Promise<ImageSidecar> {
  expect(file.sidecar.status).toBe("published");
  const text = await readFile(file.sidecarPath, "utf8");
  expect(text).not.toContain(process.env.OPENAI_API_KEY!.trim());
  const sidecar = JSON.parse(text) as ImageSidecar;
  expect(sidecar.format).toEqual({ owner: "gptimg", kind: "sidecar", version: 1 });
  expect(sidecar.operation).toBe(kind);
  expect(sidecar.writer).toEqual({ name: "gptimgsdk", version: expect.stringMatching(/^\d+\.\d+\.\d+/), caller: { name: "gptimgsdklive", version: "1" } });
  // The result carries the same record the sidecar holds, without its header.
  const { format: _format, writer: _writer, ...content } = sidecar;
  expect(file.record).toEqual(content);
  expect(sidecar.request).toMatchObject({ n: 1, ...request });
  expect(typeof sidecar.request.prompt, "the prompt is recorded").toBe("string");
  expect(typeof sidecar.response.created, "the provider's creation time is kept").toBe("number");
  expect(sidecar.response.usage, "the provider's usage is kept").toBeDefined();
  expect(sidecar.response.data?.length).toBeGreaterThan(0);
  for (const item of sidecar.response.data ?? []) expect(item.b64_json ?? null, "image bytes are left to the file").toBeNull();
  expect(sidecar.files).toEqual([{ index: 1, name: basename(file.path), sha256: file.sha256, format: file.format }]);
  return sidecar;
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
  // Folders an earlier run kept for its failures; the models stay.
  await mkdir(CACHE, { recursive: true });
  for (const entry of await readdir(CACHE)) {
    if (entry !== "models") await rm(join(CACHE, entry), { recursive: true, force: true });
  }
  await mkdir(MODELS, { recursive: true });
  const { img } = await freshSdk("install");
  await img.model.installAll();
});

afterAll(async () => {
  await Promise.all(homes.filter((home) => !keptHomes.has(home)).map((home) => rm(home, { recursive: true, force: true })));
  if (keptHomes.size > 0) process.stderr.write(`Kept for diagnosis: ${[...keptHomes].join(", ")}\n`);
});

describe("the live SDK", () => {
  it("has every pinned model installed and matching its pinned digest, and verify passes a real output", async () => {
    const { img } = await freshSdk("verify");
    for (const model of (await img.model.list()).models) expect(model.cached, model.name).toBe(true);
    const { models } = await img.model.verify();
    for (const model of models) expect(model.integrity, model.name).toBe("ok");
  });

  it("cuts the subject out of a test image with the pinned BiRefNet", async () => {
    const { img, home } = await freshSdk("mask");
    const result = done(await img.mask({ in: await copyInto(home, DISC), method: "ai", outDir: home }));
    expect(result.stats).toMatchObject({ method: "ai", model: "birefnet", width: 128, height: 128 });
    expect(await maskValue(result.output!, 64, 64), "the disc is kept").toBeGreaterThan(200);
    for (const [x, y] of [[4, 4], [123, 4], [4, 123], [123, 123]] as const) {
      expect(await maskValue(result.output!, x, y), `the backdrop at ${x},${y} is removed`).toBeLessThan(55);
    }
  });

  it("enlarges a test image with the pinned Swin2SR", async () => {
    const { img, home } = await freshSdk("upscale");
    const result = done(await img.upscale({ in: await copyInto(home, DISC), outDir: home }));
    expect(result).toMatchObject({ sourceWidth: 128, modelWidth: 512, width: 1024, height: 1024 });
    expect(await sharp(result.output).metadata()).toMatchObject({ width: 1024, height: 1024 });
    const centre = await centreColour(result.output, 0.2);
    expect(centre.r, "the disc stays red").toBeGreaterThan(centre.g + 80);
  });

  // Every supported image model, through both verbs, so each row's branch is proven against
  // the real API rather than only the default.
  for (const model of IMAGE_MODELS) {
    it(`generates and edits an image with ${model} through the real OpenAI API`, async () => {
      requireKey();
      const { img, home } = await freshSdk(`generate-${model}`);
      const result = done(await img.generate({
        prompt: "A single flat solid red circle centred on a plain white background. No shading, texture, or other objects.",
        outDir: home,
        policy: { generate: { ...CHEAPEST_IMAGE, model } },
      }));
      expect(result.failures).toEqual([]);
      expect(result.files).toHaveLength(1);
      const [file] = result.files;
      await expectCompleteImageSidecar(file!, { ...CHEAPEST_IMAGE, model, moderation: "low" });
      expect((await sharp(file!.path).metadata()).format).toBe(file!.format);
      const centre = await centreColour(file!.path, 0.2);
      expect(centre.r, "the centre is red").toBeGreaterThan(centre.g + 80);

      const edited = done(await img.edit({
        in: file!.path,
        prompt: "Recolour the red circle pure blue. Keep its size and position and keep the white background unchanged.",
        outDir: home,
        outName: "edited",
        policy: { edit: { ...CHEAPEST_IMAGE, model } },
      }));
      expect(edited.failures).toEqual([]);
      expect(edited.files).toHaveLength(1);
      const [editedFile] = edited.files;
      // The edit's record names its source by file and digest, so it stays traceable.
      await expectCompleteImageSidecar(editedFile!, {
        ...CHEAPEST_IMAGE,
        model,
        input: basename(file!.path),
        inputSha256: file!.sha256,
        mask: null,
        maskSha256: null,
      }, "edit");
      const editedCentre = await centreColour(editedFile!.path, 0.2);
      expect(editedCentre.b, "the circle is now blue").toBeGreaterThan(editedCentre.r + 80);
    });
  }

  it("writes the provider's WebP as a .webp whose sidecar names the default model, the file and the key colour mask reads", async () => {
    requireKey();
    const { img, home } = await freshSdk("generate-webp");
    const result = done(await img.generate({
      prompt: "A single flat solid red circle centred on a plain white background.",
      outDir: home,
      policy: { generate: { ...CHEAPEST_IMAGE, output_format: "webp" }, chroma: { color: "#00ff00" } },
    }));
    const [file] = result.files;
    expect(file!.path.endsWith(".webp")).toBe(true);
    expect((await sharp(file!.path).metadata()).format).toBe("webp");
    await expectCompleteImageSidecar(file!, {
      model: "gpt-image-2.5-flare",
      output_format: "webp",
      chroma: { color: "#00ff00" },
    });
    const keyed = done(await img.mask({ in: file!.path, method: "chroma", key: "from-sidecar", outName: "keyed" }));
    expect(keyed.stats).toMatchObject({ key: "#00ff00", keySource: "sidecar" });
    // The real output passes verification against its sidecar.
    expect(done(await img.verify({ in: file!.path }))).toMatchObject({ ok: true, findings: [] });
  });

  // A vision model honours detail=low when a low-detail check of a large photo stays under the
  // prompt-token bound below, which only a low-detail image fits.
  for (const model of DETAIL_CHECKED_VISION_MODELS) {
    it(`bills ${model} a low-detail image at low-detail cost`, async () => {
      requireKey();
      const { img, home } = await freshSdk(`detail-${model}`);
      const photo = await copyInto(home, join(CORPUS, CAT_PHOTO));
      const holds = done(await img.vision({
        inputs: [photo],
        check: "A cat is visible in the image.",
        outDir: home,
        policy: { vision: { ...CHEAPEST_VISION, model } },
      }));
      const sidecar = JSON.parse(await readFile(holds.sidecarPath, "utf8")) as {
        request: Record<string, unknown>;
        response: { raw: { usage?: { prompt_tokens?: number } } };
      };
      expect(sidecar.request).toMatchObject({ model, ...CHEAPEST_VISION });
      const promptTokens = sidecar.response.raw.usage?.prompt_tokens ?? Number.POSITIVE_INFINITY;
      expect(promptTokens, `${model} prompt tokens at detail=low`).toBeLessThan(1_000);
      expect(holds.ok, holds.reasons.join(" ")).toBe(true);
    });
  }

  // Every supported vision row at its own default effort, sent as reasoning_effort, and the
  // default detail, sent as "auto", on a 128 px image.
  for (const row of VISION_ROWS) {
    it(`judges a tiny image with ${row.id} at its default effort and detail`, async () => {
      requireKey();
      const { img, home } = await freshSdk(`effort-${row.id}`);
      const result = done(await img.vision({
        inputs: [await copyInto(home, DISC)],
        check: "A red disc is visible.",
        outDir: home,
        policy: { vision: { model: row.id } },
      }));
      expect(await sentRequest(result.sidecarPath)).toMatchObject({
        model: row.id,
        detail: "auto",
        reasoning: row.defaultThinking,
      });
      expect(typeof result.ok, result.reasons.join(" ")).toBe("boolean");
    });
  }

  it("judges a corpus photo through the real OpenAI vision model", async () => {
    requireKey();
    const { img, home } = await freshSdk("vision");
    const photo = await copyInto(home, join(CORPUS, CAT_PHOTO));
    const holds = done(await img.vision({
      inputs: [photo],
      check: "A cat is visible in the image.",
      outDir: home,
      policy: { vision: CHEAPEST_VISION },
    }));
    expect(holds.ok, holds.reasons.join(" ")).toBe(true);
    // The verdict's record: what was asked of which image, and the answer with its time and usage.
    const text = await readFile(holds.sidecarPath, "utf8");
    expect(text).not.toContain(process.env.OPENAI_API_KEY!.trim());
    const { format, writer: _writer, ...sidecar } = JSON.parse(text) as {
      format: unknown;
      writer: unknown;
      request: Record<string, unknown>;
      response: { verdict: unknown; raw: { created?: unknown; model?: unknown; usage?: unknown } };
      files: unknown[];
    };
    expect(format).toEqual({ owner: "gptimg", kind: "sidecar", version: 1 });
    expect(holds.sidecar).toEqual({ status: "published" });
    expect(holds.record).toEqual(sidecar);
    expect(sidecar.request).toMatchObject({
      ...CHEAPEST_VISION,
      model: "gpt-6-luna",
      check: "A cat is visible in the image.",
      inputs: [{ name: basename(photo), sha256: createHash("sha256").update(await readFile(photo)).digest("hex") }],
    });
    expect((sidecar.request.inputs as Array<{ shrink?: unknown }>)[0]?.shrink).toMatchObject({
      applied: expect.any(Boolean),
      outputWidth: expect.any(Number),
      outputHeight: expect.any(Number),
    });
    expect(sidecar.response.verdict).toEqual({ ok: holds.ok, score: holds.score, reasons: holds.reasons });
    expect(typeof sidecar.response.raw.created, "the provider's creation time is kept").toBe("number");
    expect(typeof sidecar.response.raw.model).toBe("string");
    expect(sidecar.response.raw.usage, "the provider's usage is kept").toBeDefined();
    expect(sidecar.files).toEqual([]);
    const fails = done(await img.vision({
      inputs: [photo],
      check: "A dog is visible in the image.",
      outDir: home,
      outName: "dog-check",
      policy: { vision: CHEAPEST_VISION },
    }));
    expect(fails.ok, fails.reasons.join(" ")).toBe(false);
  });

  // A conversation through the Responses API: a first turn that makes an image, a follow-up
  // chained from OpenAI's stored copy that edits it, and a turn whose previous response
  // OpenAI does not hold, which must resend the history. The cheapest assistant and image
  // settings keep the three turns to a few cents.
  it("holds a chat: generates, edits through the stored conversation, and resends when the stored copy is gone", async () => {
    requireKey();
    const { img, home } = await freshSdk("chat");
    const policy = { chat: { model: "gpt-6-luna", reasoning: "none", quality: "low", size: "1024x1024" } };
    const first = done(await img.chat({
      message: "Draw a simple red circle on a white background.",
      outDir: home,
      outName: "turn-1",
      policy,
    }));
    expect(first.resumed).toBeNull();
    expect(first.files.length, first.text).toBeGreaterThan(0);
    expect(first.response.usage, "the turn's usage is kept").toBeDefined();
    const record = JSON.parse(await readFile(first.files[0]!.sidecarPath, "utf8")) as { kind: string; request: Record<string, unknown>; response: unknown };
    expect(record).toMatchObject({ kind: "chat", request: { model: "gpt-6-luna", reasoning: "none", previousResponseId: null } });
    expect(JSON.stringify(record)).not.toContain(process.env.OPENAI_API_KEY!.trim());
    expect(done(await img.verify({ in: first.files[0]!.path }))).toMatchObject({ ok: true });

    const second = done(await img.chat({
      message: "Make the circle blue.",
      previousResponseId: first.responseId,
      history: [{ role: "user", text: "Draw a simple red circle on a white background." }, { role: "assistant", text: first.text, images: first.files.map((f) => f.path) }],
      outDir: home,
      outName: "turn-2",
      policy,
    }));
    expect(second.resumed).toBe("chain");
    expect(second.files.length, second.text).toBeGreaterThan(0);

    const gone = done(await img.chat({
      message: "Now make it green.",
      previousResponseId: `resp_${"0".repeat(48)}`,
      history: [
        { role: "user", text: "Draw a simple red circle on a white background." },
        { role: "assistant", text: first.text, images: first.files.map((f) => f.path) },
        { role: "user", text: "Make the circle blue." },
        { role: "assistant", text: second.text, images: second.files.map((f) => f.path) },
      ],
      outDir: home,
      outName: "turn-3",
      policy,
    }));
    expect(gone.resumed).toBe("resent");
    expect(gone.files.length, gone.text).toBeGreaterThan(0);
  });
});
