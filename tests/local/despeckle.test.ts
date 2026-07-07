import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDespeckle } from "../../src/local/despeckle.js";

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
function setA(buf: Uint8Array, W: number, x: number, y: number, a: number): void {
  const i = (y * W + x) * 4;
  buf[i] = 200;
  buf[i + 1] = 100;
  buf[i + 2] = 50;
  buf[i + 3] = a;
}
function fillRect(
  buf: Uint8Array,
  W: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  a: number,
): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setA(buf, W, x, y, a);
}
function alphaAt(img: { data: Uint8Array; width: number }, x: number, y: number): number {
  return img.data[(y * img.width + x) * 4 + 3]!;
}

describe("runDespeckle", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-despeckle-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("floors alpha below threshold and keeps alpha >= threshold", async () => {
    // 4x1 row: alphas [3, 5, 200, 0]
    const W = 4, H = 1;
    const buf = blank(W, H);
    setA(buf, W, 0, 0, 3);
    setA(buf, W, 1, 0, 5);
    setA(buf, W, 2, 0, 200);
    const inPath = path.join(tmp, "in.png");
    const outPath = path.join(tmp, "out.png");
    await writeRawPng(inPath, W, H, buf);

    const res = await runDespeckle({ in: inPath, out: outPath, threshold: 5, minArea: 0 });
    expect(res.flooredPixels).toBe(1); // the alpha-3 pixel
    expect(res.removedPixels).toBe(0);

    const out = await readRGBA(outPath);
    expect(alphaAt(out, 0, 0)).toBe(0); // floored
    expect(alphaAt(out, 1, 0)).toBe(5); // kept (== threshold)
    expect(alphaAt(out, 2, 0)).toBe(200); // kept
  });

  it("removes a small isolated speckle but keeps every large component (multi-piece safe)", async () => {
    const W = 20, H = 10;
    const buf = blank(W, H);
    fillRect(buf, W, 1, 1, 5, 5, 255); // blob A, area 25
    fillRect(buf, W, 12, 1, 16, 5, 255); // blob B, area 25
    setA(buf, W, 18, 8, 255); // lone speckle, area 1
    const inPath = path.join(tmp, "in.png");
    const outPath = path.join(tmp, "out.png");
    await writeRawPng(inPath, W, H, buf);

    const res = await runDespeckle({
      in: inPath,
      out: outPath,
      threshold: 5,
      minArea: 10,
      connectivity: 8,
      keep: "all",
    });
    expect(res.components).toBe(3);
    expect(res.removedComponents).toBe(1);
    expect(res.removedPixels).toBe(1);
    // bbox shrinks once the far speckle is gone.
    expect(res.bboxBefore).toEqual({ x: 1, y: 1, width: 18, height: 8 });
    expect(res.bboxAfter).toEqual({ x: 1, y: 1, width: 16, height: 5 });

    const out = await readRGBA(outPath);
    expect(alphaAt(out, 3, 3)).toBe(255); // blob A kept
    expect(alphaAt(out, 14, 3)).toBe(255); // blob B kept
    expect(alphaAt(out, 18, 8)).toBe(0); // speckle removed
  });

  it("keep=largest keeps only the biggest component", async () => {
    const W = 20, H = 10;
    const buf = blank(W, H);
    fillRect(buf, W, 1, 1, 5, 5, 255); // blob A, area 25 (largest)
    fillRect(buf, W, 12, 1, 14, 3, 255); // blob B, area 9
    const inPath = path.join(tmp, "in.png");
    const outPath = path.join(tmp, "out.png");
    await writeRawPng(inPath, W, H, buf);

    const res = await runDespeckle({ in: inPath, out: outPath, threshold: 5, keep: "largest" });
    expect(res.components).toBe(2);
    expect(res.removedComponents).toBe(1);
    expect(res.removedPixels).toBe(9);

    const out = await readRGBA(outPath);
    expect(alphaAt(out, 3, 3)).toBe(255); // largest kept
    expect(alphaAt(out, 13, 2)).toBe(0); // smaller removed
  });

  it("connectivity changes whether a diagonal pair is one component", async () => {
    const W = 4, H = 4;
    const in4 = path.join(tmp, "in4.png");
    const in8 = path.join(tmp, "in8.png");
    const buf = blank(W, H);
    setA(buf, W, 1, 1, 255);
    setA(buf, W, 2, 2, 255); // touches (1,1) only diagonally
    await writeRawPng(in4, W, H, buf);
    await writeRawPng(in8, W, H, buf);

    const r4 = await runDespeckle({
      in: in4,
      out: path.join(tmp, "o4.png"),
      threshold: 5,
      minArea: 2,
      connectivity: 4,
    });
    expect(r4.components).toBe(2); // two separate 1-px components
    expect(r4.removedPixels).toBe(2); // both < minArea 2

    const r8 = await runDespeckle({
      in: in8,
      out: path.join(tmp, "o8.png"),
      threshold: 5,
      minArea: 2,
      connectivity: 8,
    });
    expect(r8.components).toBe(1); // one 2-px diagonal component
    expect(r8.removedPixels).toBe(0); // size 2 >= minArea 2
  });

  it("is a graceful no-op on a fully-transparent image", async () => {
    const W = 8, H = 8;
    const inPath = path.join(tmp, "blank.png");
    const outPath = path.join(tmp, "out.png");
    await writeRawPng(inPath, W, H, blank(W, H));

    const res = await runDespeckle({ in: inPath, out: outPath, threshold: 5, minArea: 10 });
    expect(res.output).toBe(outPath);
    expect(res.components).toBe(0);
    expect(res.removedPixels).toBe(0);
    expect(res.flooredPixels).toBe(0);
    expect(res.bboxBefore).toBeNull();
    expect(res.bboxAfter).toBeNull();

    const out = await readRGBA(outPath);
    expect(out.width).toBe(W);
    let maxAlpha = 0;
    for (let p = 0; p < W * H; p++) maxAlpha = Math.max(maxAlpha, out.data[p * 4 + 3]!);
    expect(maxAlpha).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Heavy algorithm coverage. Targeted edge cases, then a differential property
// suite: an INDEPENDENT reference (derived from the contract — floor, then
// connected-component filter — not copied from the impl) is run against
// `runDespeckle` over many seeded-random images and parameter combinations,
// asserting exact per-pixel alpha and every stat, plus the core invariants
// (RGB untouched, alpha only ever drops to 0, idempotence).
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) so the property suite is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RefResult {
  expectedAlpha: Uint8Array;
  flooredPixels: number;
  components: number;
  removedComponents: number;
  removedPixels: number;
}

/**
 * Reference despeckle over an alpha plane, written from the documented contract.
 * Labels components in row-major first-encounter order (matching the impl's
 * scan) so `keep:"largest"` tie-breaking lines up.
 */
function referenceDespeckle(
  alpha: Uint8Array,
  W: number,
  H: number,
  threshold: number,
  minArea: number,
  connectivity: 4 | 8,
  keep: "all" | "largest",
): RefResult {
  const n = W * H;
  const presentLevel = threshold < 1 ? 1 : threshold;
  const present = new Uint8Array(n);
  let flooredPixels = 0;
  for (let p = 0; p < n; p++) {
    const a = alpha[p]!;
    if (a >= presentLevel) present[p] = 1;
    else if (a > 0) flooredPixels++;
  }
  const neigh4: [number, number][] = [[0, -1], [-1, 0], [1, 0], [0, 1]];
  const neigh8: [number, number][] = [...neigh4, [-1, -1], [1, -1], [-1, 1], [1, 1]];
  const neigh = connectivity === 8 ? neigh8 : neigh4;
  const label = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  for (let s = 0; s < n; s++) {
    if (present[s] === 0 || label[s] !== -1) continue;
    const id = sizes.length;
    const stack = [s];
    label[s] = id;
    let size = 0;
    while (stack.length > 0) {
      const p = stack.pop()!;
      size++;
      const px = p % W;
      const py = (p / W) | 0;
      for (const [dx, dy] of neigh) {
        const nx = px + dx;
        const ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const np = ny * W + nx;
        if (present[np] === 1 && label[np] === -1) {
          label[np] = id;
          stack.push(np);
        }
      }
    }
    sizes.push(size);
  }
  const components = sizes.length;
  const remove = new Uint8Array(components);
  let removedComponents = 0;
  if (keep === "largest") {
    if (components > 0) {
      let largest = 0;
      for (let c = 1; c < components; c++) if (sizes[c]! > sizes[largest]!) largest = c;
      for (let c = 0; c < components; c++) if (c !== largest) { remove[c] = 1; removedComponents++; }
    }
  } else {
    for (let c = 0; c < components; c++) if (sizes[c]! < minArea) { remove[c] = 1; removedComponents++; }
  }
  const expectedAlpha = new Uint8Array(n);
  let removedPixels = 0;
  for (let p = 0; p < n; p++) {
    const id = label[p]!;
    if (present[p] === 1 && id !== -1 && remove[id] === 1) { removedPixels++; }
    else if (present[p] === 1) { expectedAlpha[p] = alpha[p]!; }
    // floored / background pixels stay 0
  }
  return { expectedAlpha, flooredPixels, components, removedComponents, removedPixels };
}

describe("runDespeckle — algorithm edge cases & differential property suite", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-despeckle-alg-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("threshold floors strictly below it and keeps the rest, incl. the α=128 level", async () => {
    const alphas = [1, 4, 5, 6, 127, 128, 255];
    const W = alphas.length, H = 1;
    const buf = blank(W, H);
    alphas.forEach((a, x) => setA(buf, W, x, 0, a));
    const inPath = path.join(tmp, "in.png");
    const outPath = path.join(tmp, "out.png");
    await writeRawPng(inPath, W, H, buf);

    const res = await runDespeckle({ in: inPath, out: outPath, threshold: 5, minArea: 0 });
    expect(res.flooredPixels).toBe(2); // α=1 and α=4
    const out = await readRGBA(outPath);
    expect([0, 1, 2, 3, 4, 5, 6].map((x) => alphaAt(out, x, 0))).toEqual([0, 0, 5, 6, 127, 128, 255]);
  });

  it("threshold=0 keeps any non-zero alpha but never the transparent background", async () => {
    const W = 5, H = 1;
    const buf = blank(W, H);
    setA(buf, W, 2, 0, 1); // a single α=1 pixel; rest fully transparent
    const inPath = path.join(tmp, "in.png");
    await writeRawPng(inPath, W, H, buf);

    // No floor, no min-area: the lone faint pixel survives (it is "present").
    const keep0 = await runDespeckle({ in: inPath, out: path.join(tmp, "a.png"), threshold: 0, minArea: 0 });
    expect(keep0.flooredPixels).toBe(0);
    expect(keep0.components).toBe(1);
    expect(keep0.removedPixels).toBe(0);

    // With min-area 2 it is a 1-px component and is dropped — confirming α=0 was never "present".
    const drop = await runDespeckle({ in: inPath, out: path.join(tmp, "b.png"), threshold: 0, minArea: 2 });
    expect(drop.components).toBe(1);
    expect(drop.removedPixels).toBe(1);
    expect(alphaAt(await readRGBA(path.join(tmp, "b.png")), 2, 0)).toBe(0);
  });

  it("keep=largest breaks ties toward the first component in scan order", async () => {
    const W = 10, H = 3;
    const buf = blank(W, H);
    fillRect(buf, W, 0, 0, 1, 1, 255); // blob A: top-left, area 4, scanned first
    fillRect(buf, W, 7, 1, 8, 2, 255); // blob B: same area 4, scanned later
    const inPath = path.join(tmp, "in.png");
    const outPath = path.join(tmp, "out.png");
    await writeRawPng(inPath, W, H, buf);

    const res = await runDespeckle({ in: inPath, out: outPath, threshold: 5, keep: "largest" });
    expect(res.components).toBe(2);
    expect(res.removedComponents).toBe(1);
    const out = await readRGBA(outPath);
    expect(alphaAt(out, 0, 0)).toBe(255); // first-scanned blob A kept on the tie
    expect(alphaAt(out, 7, 1)).toBe(0); // later blob B dropped
  });

  it("never fills an interior hole (only zeros alpha)", async () => {
    const W = 7, H = 7;
    const buf = blank(W, H);
    fillRect(buf, W, 1, 1, 5, 5, 255); // solid block...
    setA(buf, W, 3, 3, 0); // ...with a transparent hole in the middle
    const inPath = path.join(tmp, "in.png");
    const outPath = path.join(tmp, "out.png");
    await writeRawPng(inPath, W, H, buf);

    const res = await runDespeckle({ in: inPath, out: outPath, threshold: 5, minArea: 4, connectivity: 4 });
    expect(res.components).toBe(1); // the ring is one component
    expect(res.removedPixels).toBe(0);
    const out = await readRGBA(outPath);
    expect(alphaAt(out, 3, 3)).toBe(0); // hole untouched (not filled)
    expect(alphaAt(out, 1, 1)).toBe(255); // ring kept
  });

  it("matches an independent reference (exact pixels + stats) over random images and params", async () => {
    const rng = mulberry32(0x5eed1234);
    for (let iter = 0; iter < 40; iter++) {
      const W = 8 + Math.floor(rng() * 24);
      const H = 8 + Math.floor(rng() * 24);
      const n = W * H;
      const buf = new Uint8Array(n * 4);
      const inAlpha = new Uint8Array(n);
      for (let p = 0; p < n; p++) {
        const a = rng() > 0.4 ? 1 + Math.floor(rng() * 255) : 0; // ~40% transparent
        buf[p * 4] = Math.floor(rng() * 256);
        buf[p * 4 + 1] = Math.floor(rng() * 256);
        buf[p * 4 + 2] = Math.floor(rng() * 256);
        buf[p * 4 + 3] = a;
        inAlpha[p] = a;
      }
      const threshold = Math.floor(rng() * 12); // 0..11
      const minArea = Math.floor(rng() * 8); // 0..7
      const connectivity: 4 | 8 = rng() > 0.5 ? 8 : 4;
      const keep: "all" | "largest" = rng() > 0.5 ? "all" : "largest";

      const inPath = path.join(tmp, `r${iter}.png`);
      const outPath = path.join(tmp, `r${iter}-out.png`);
      await writeRawPng(inPath, W, H, buf);
      const res = await runDespeckle({ in: inPath, out: outPath, threshold, minArea, connectivity, keep });
      const ref = referenceDespeckle(inAlpha, W, H, threshold, minArea, connectivity, keep);
      const out = await readRGBA(outPath);

      const ctx = `iter=${iter} W=${W} H=${H} t=${threshold} m=${minArea} c=${connectivity} keep=${keep}`;
      expect(res.flooredPixels, ctx).toBe(ref.flooredPixels);
      expect(res.components, ctx).toBe(ref.components);
      expect(res.removedComponents, ctx).toBe(ref.removedComponents);
      expect(res.removedPixels, ctx).toBe(ref.removedPixels);

      for (let p = 0; p < n; p++) {
        const outA = out.data[p * 4 + 3]!;
        expect(outA, `${ctx} alpha@${p}`).toBe(ref.expectedAlpha[p]!);
        expect(out.data[p * 4], `${ctx} R@${p}`).toBe(buf[p * 4]!); // RGB untouched
        expect(out.data[p * 4 + 1], `${ctx} G@${p}`).toBe(buf[p * 4 + 1]!);
        expect(out.data[p * 4 + 2], `${ctx} B@${p}`).toBe(buf[p * 4 + 2]!);
        expect(outA === 0 || outA === inAlpha[p]!, `${ctx} monotonic@${p}`).toBe(true); // 0 or original; never raised
      }

      // Idempotence: a second pass with the same params changes nothing.
      const out2Path = path.join(tmp, `r${iter}-out2.png`);
      const res2 = await runDespeckle({ in: outPath, out: out2Path, threshold, minArea, connectivity, keep });
      expect(res2.flooredPixels, ctx).toBe(0);
      expect(res2.removedPixels, ctx).toBe(0);
      const out2 = await readRGBA(out2Path);
      for (let p = 0; p < n; p++) expect(out2.data[p * 4 + 3], `${ctx} idem@${p}`).toBe(out.data[p * 4 + 3]!);
    }
  });
});
