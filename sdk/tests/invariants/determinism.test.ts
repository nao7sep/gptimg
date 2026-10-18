import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GptImg } from "../../src/index.ts";
import { done } from "../helpers/results.ts";

/**
 * Every local verb is deterministic: the same inputs and arguments, run twice
 * into two folders through the public GptImg class, write byte-identical files.
 * Upscale and mask with method "ai" need ONNX models and are left out.
 */

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures");
const greenDisk = path.join(FIXTURES, "green-disk.png");
const donut = path.join(FIXTURES, "donut.png");

let tmp: string;
let inputs: string;
let cutout: string;
let maskA: string;
let maskB: string;
let master: string;
let base: string;
const sdk = new GptImg();

/** A transparent canvas with a soft-edged disc, a faint wash and two specks. */
function cutoutPixels(size: number): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const d = Math.hypot(x - c, y - c);
      const alpha = d < size * 0.3 ? 255 : d < size * 0.36 ? Math.round(255 * (size * 0.36 - d) / (size * 0.06)) : 2;
      data.set([(x * 7) % 256, 180, (y * 5) % 256, alpha], i);
    }
  }
  for (const [x, y] of [[2, 2], [size - 3, 4]]) data.set([0, 255, 0, 255], (y! * size + x!) * 4);
  return data;
}

async function writeRaw(file: string, width: number, height: number, channels: 1 | 4, data: Uint8Array): Promise<void> {
  await sharp(Buffer.from(data), { raw: { width, height, channels } }).png().toFile(file);
}

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "gptimg-determinism-"));
  inputs = path.join(tmp, "inputs");
  await mkdir(inputs);

  cutout = path.join(inputs, "cutout.png");
  await writeRaw(cutout, 64, 64, 4, cutoutPixels(64));

  maskA = path.join(inputs, "mask-a.png");
  maskB = path.join(inputs, "mask-b.png");
  await writeRaw(maskA, 32, 32, 1, Uint8Array.from({ length: 32 * 32 }, (_, p) => (p * 37) % 256));
  await writeRaw(maskB, 32, 32, 1, Uint8Array.from({ length: 32 * 32 }, (_, p) => ((p % 32) < 16 ? 255 : (p * 11) % 256)));

  base = path.join(inputs, "base.png");
  await writeRaw(base, 96, 96, 4, Uint8Array.from({ length: 96 * 96 * 4 }, (_, i) => (i % 4 === 3 ? 255 : (i * 13) % 256)));

  master = path.join(inputs, "master.png");
  const side = 1024;
  await writeRaw(
    master,
    side,
    side,
    4,
    Uint8Array.from({ length: side * side * 4 }, (_, i) => {
      const p = i >> 2;
      const x = p % side;
      const y = (p - x) / side;
      return [x >> 2, y >> 2, (x + y) >> 3, 255][i & 3]!;
    }),
  );
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Every file under `dir`, relative path to bytes. */
async function snapshot(dir: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    files.set(path.relative(dir, full), await readFile(full));
  }
  return files;
}

type Run = (outDir: string) => Promise<unknown>;

const verbs: Array<[string, Run]> = [
  ["trim", async (outDir) => done(await sdk.trim({ in: cutout, margin: 0.1, square: true, outDir, outName: "out" }))],
  [
    "backplate",
    async (outDir) =>
      done(await sdk.backplate({ size: 96, from: "#336699", to: "#ffcc00", angle: 135, shape: "squircle", outDir, outName: "out" })),
  ],
  [
    "compose",
    async (outDir) =>
      done(await sdk.compose({ in: greenDisk, mask: maskOf(greenDisk), removeBleed: "#00ff00", outDir, outName: "out" })),
  ],
  ["compose over color", async (outDir) => done(await sdk.compose({ in: greenDisk, mask: maskOf(greenDisk), over: "#202020", outDir, outName: "out" }))],
  ["combine union", async (outDir) => done(await sdk.combine({ op: "union", inputs: [maskA, maskB], outDir, outName: "out" }))],
  ["combine feather", async (outDir) => done(await sdk.combine({ op: "feather", inputs: [maskA], radius: 3, outDir, outName: "out" }))],
  ["despeckle", async (outDir) => done(await sdk.despeckle({ in: cutout, threshold: 5, minArea: 4, outDir, outName: "out" }))],
  ["shadow", async (outDir) => done(await sdk.shadow({ in: cutout, blur: 4, spread: 2, offset: { x: 3, y: 5 }, outDir, outName: "out" }))],
  ["layer", async (outDir) => done(await sdk.layer({ base, top: cutout, scale: 0.7, gravity: "center", outDir, outName: "out" }))],
  ["icon", async (outDir) => done(await sdk.icon({ in: master, name: "icon", pngs: true, outDir }))],
  ["resize", async (outDir) => done(await sdk.resize({ in: cutout, toSize: 48, kernel: "lanczos3", outDir, outName: "out" }))],
  ["encode webp lossy", async (outDir) => done(await sdk.encode({ in: cutout, format: "webp", quality: 70, outDir, outName: "out" }))],
  ["encode webp lossless", async (outDir) => done(await sdk.encode({ in: cutout, format: "webp", lossless: true, outDir, outName: "out" }))],
  ["encode png", async (outDir) => done(await sdk.encode({ in: donut, format: "png", compressionLevel: 9, outDir, outName: "out" }))],
  [
    "grid",
    async (outDir) =>
      done(await sdk.grid({ inputs: [cutout, greenDisk, donut], cols: 2, cell: 48, gap: 4, background: "#ffffff", outDir, outName: "out" })),
  ],
  ["mask chroma", async (outDir) => done(await sdk.mask({ in: greenDisk, method: "chroma", preserveInterior: true, outDir, outName: "out" }))],
  ["keycheck heatmap", async (outDir) => done(await sdk.keycheck({ in: cutout, key: "#00ff00", heatmap: true, outDir, outName: "out" }))],
];

/** The chroma mask of `input`, written once into the shared inputs folder. */
function maskOf(input: string): string {
  return path.join(inputs, `${path.basename(input, ".png")}-mask.png`);
}

describe("local verbs are deterministic", () => {
  beforeAll(async () => {
    done(await sdk.mask({ in: greenDisk, method: "chroma", outDir: inputs }));
  });

  it.each(verbs)("%s writes byte-identical files on a second run", async (name, run) => {
    const slug = name.replace(/\s+/g, "-");
    const first = path.join(tmp, `${slug}-1`);
    const second = path.join(tmp, `${slug}-2`);
    await run(first);
    await run(second);
    const a = await snapshot(first);
    const b = await snapshot(second);
    expect(a.size).toBeGreaterThan(0);
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    for (const [file, bytes] of a) {
      expect(bytes.equals(b.get(file)!), `${name}: ${file} differs between runs`).toBe(true);
    }
  });
});
