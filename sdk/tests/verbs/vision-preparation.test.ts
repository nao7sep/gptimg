import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import { GptImg } from "../../src/index.ts";
import { done } from "../helpers/results.ts";

const state = vi.hoisted(() => ({ active: 0, peak: 0, started: 0, release: undefined as (() => void) | undefined, entered: undefined as (() => void) | undefined, images: [] as Array<{ data: Uint8Array }> }));
vi.mock("../../src/image/shrinkForVision.ts", async (original) => {
  const real = await original<typeof import("../../src/image/shrinkForVision.ts")>();
  return { shrinkForVision: async (...args: Parameters<typeof real.shrinkForVision>) => {
    state.started++;
    state.peak = Math.max(state.peak, ++state.active);
    if (state.started === 1) await new Promise<void>((resolve) => { state.release = resolve; state.entered?.(); });
    try { return await real.shrinkForVision(...args); } finally { state.active--; }
  } };
});
vi.mock("../../src/providers/index.ts", () => ({ getProvider: () => ({ vision: async (args: { images: Array<{ data: Uint8Array }> }) => {
  state.images = args.images;
  return { verdict: { ok: true, score: 1, reasons: [] }, raw: {} };
} }) }));
let tmp: string;
afterEach(async () => { state.release?.(); await rm(tmp, { recursive: true, force: true }); });
it("prepares camera-sized inputs one at a time, preserving order, source digests and shrunk images", async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "gptimg-vision-preparation-"));
  state.active = state.peak = state.started = 0;
  const inputs: string[] = [];
  for (const color of ["red", "green", "blue"]) {
    const input = path.join(tmp, `${color}.jpg`);
    await writeFile(input, await sharp({ create: { width: 2400, height: 1600, channels: 3, background: color } }).jpeg().toBuffer());
    inputs.push(input);
  }
  const hashes = await Promise.all(inputs.map(async (input) => createHash("sha256").update(await readFile(input)).digest("hex")));
  const entered = new Promise<void>((resolve) => { state.entered = resolve; });
  const call = new GptImg({ apiKey: "offline" }).vision({ inputs, check: "colors", outName: "vision" });
  await entered;
  state.release!();
  const result = done(await call);
  expect(state.peak).toBe(1);
  expect(result.record.request.inputs.map((input) => input.sha256)).toEqual(hashes);
  expect(result.record.request.inputs.map((input) => input.name)).toEqual(["red.jpg", "green.jpg", "blue.jpg"]);
  expect(state.images).toHaveLength(3);
  for (const image of state.images) {
    const meta = await sharp(image.data).metadata();
    expect(meta.width).toBeLessThan(2400);
    expect(meta.height).toBeLessThan(1600);
  }
});
