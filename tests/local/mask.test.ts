import { mkdtemp, rm, copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chromaMask, chromaMaskFromFile } from "../../src/local/chroma/mask.js";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "fixtures");

function fixture(name: string): string {
  return path.join(FIXTURES, name);
}

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

describe("chromaMask: green disk fixture", () => {
  it("removes the green border and keeps the disk", async () => {
    const res = await chromaMaskFromFile({ in: fixture("green-disk.png") });
    expect(res.stats.removedFraction).toBeGreaterThan(0.78);
    expect(res.stats.removedFraction).toBeLessThan(0.88);
    expect(res.stats.key).toMatch(/^#[0-9a-f]{6}$/);
    expect(res.stats.keySource).toBe("auto");
  });

  it("loads chroma color from the per-image sidecar via from-sidecar", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "gptimg-mask-sidecar-"));
    try {
      // Per-image sidecar contract: image `generated-01.png` reads its sidecar
      // from `generated-01.json` (not a shared `generated.json`).
      const input = path.join(tmp, "generated-01.png");
      await copyFile(fixture("green-disk.png"), input);
      await writeFile(
        path.join(tmp, "generated-01.json"),
        JSON.stringify({
          request: { chroma: { color: "#00ff00" } },
          response: {},
          files: [],
        }) + "\n",
      );

      const res = await chromaMaskFromFile({ in: input, key: "from-sidecar" });
      expect(res.stats.key).toBe("#00ff00");
      expect(res.stats.keySource).toBe("sidecar");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("from-sidecar does not strip non-index `-NN` suffixes (date-stamped names)", async () => {
    // Regression: previously a regex stripped trailing -\d+, so
    // `donut-2024-05-28.png` looked up `donut-2024-05.json`. The
    // per-image-sidecar contract removes the regex; the sidecar must
    // exist at the literal stem.
    const tmp = await mkdtemp(path.join(tmpdir(), "gptimg-mask-sidecar-date-"));
    try {
      const input = path.join(tmp, "donut-2024-05-28.png");
      await copyFile(fixture("green-disk.png"), input);
      await writeFile(
        path.join(tmp, "donut-2024-05-28.json"),
        JSON.stringify({
          request: { chroma: { color: "#00ff00" } },
          response: {},
          files: [],
        }) + "\n",
      );

      const res = await chromaMaskFromFile({ in: input, key: "from-sidecar" });
      expect(res.stats.key).toBe("#00ff00");
      expect(res.stats.keySource).toBe("sidecar");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("chromaMask: spill formula", () => {
  it("makes pure-key pixels α=0 and unrelated subject pixels α=255", async () => {
    const W = 32;
    const H = 32;
    const rgba = new Uint8Array(W * H * 4);
    for (let p = 0, i = 0; p < W * H; p++, i += 4) {
      rgba[i] = 0;
      rgba[i + 1] = 255;
      rgba[i + 2] = 0;
      rgba[i + 3] = 255;
    }
    for (let y = 8; y < 24; y++) {
      for (let x = 8; x < 24; x++) {
        const i = (y * W + x) * 4;
        rgba[i] = 220;
        rgba[i + 1] = 200;
        rgba[i + 2] = 60;
      }
    }
    const res = await chromaMask(rgba, W, H, { key: "#00ff00" });
    expect(res.stats.key).toBe("#00ff00");
    expect(res.alpha[0]).toBe(0);
    const subject = 16 * W + 16;
    expect(res.alpha[subject]).toBe(255);
  });

  it("rejects an out-of-range saturationRatio instead of silently clamping", async () => {
    const W = 8;
    const H = 8;
    const rgba = new Uint8Array(W * H * 4);
    for (let p = 0, i = 0; p < W * H; p++, i += 4) {
      rgba[i + 1] = 255;
      rgba[i + 3] = 255;
    }
    await expect(
      chromaMask(rgba, W, H, { key: "#00ff00", saturationRatio: 5 }),
    ).rejects.toThrow(/saturationRatio must be in \(0\.\.1\]/);
  });

  it("handles a magenta (secondary) key correctly", async () => {
    const W = 32;
    const H = 32;
    const rgba = new Uint8Array(W * H * 4);
    for (let p = 0, i = 0; p < W * H; p++, i += 4) {
      rgba[i] = 255;
      rgba[i + 1] = 0;
      rgba[i + 2] = 255;
      rgba[i + 3] = 255;
    }
    for (let y = 8; y < 24; y++) {
      for (let x = 8; x < 24; x++) {
        const i = (y * W + x) * 4;
        rgba[i] = 230;
        rgba[i + 1] = 180;
        rgba[i + 2] = 50;
      }
    }
    const res = await chromaMask(rgba, W, H, { key: "#ff00ff" });
    expect(res.alpha[0]).toBe(0);
    const subject = 16 * W + 16;
    expect(res.alpha[subject]).toBe(255);
  });

  it("uses border-derived strength so a drifted bg keys cleanly (stated #ff00ff, actual ≈ #fa01df)", async () => {
    // The h02 failure mode: an explicit / from-sidecar key states the ideal
    // hex, but the AI-painted bg drifts (here #fa01df = 250,1,223 — B=223
    // instead of 255). Before the fix, strength came from the ideal hex
    // (1.0) and the drifted bg only reached ~0.745 spill → α≈23, not 0.
    // After the fix, strength comes from the actual border average → α=0.
    const W = 32;
    const H = 32;
    const rgba = new Uint8Array(W * H * 4);
    for (let p = 0, i = 0; p < W * H; p++, i += 4) {
      rgba[i] = 250;
      rgba[i + 1] = 1;
      rgba[i + 2] = 223;
      rgba[i + 3] = 255;
    }
    for (let y = 12; y < 20; y++) {
      for (let x = 12; x < 20; x++) {
        const i = (y * W + x) * 4;
        rgba[i] = 50;
        rgba[i + 1] = 50;
        rgba[i + 2] = 50;
      }
    }
    const res = await chromaMask(rgba, W, H, { key: "#ff00ff" });
    expect(res.alpha[0]).toBe(0);
    const subject = 16 * W + 16;
    expect(res.alpha[subject]).toBe(255);
  });
});

describe("chromaMask: preserveInterior", () => {
  it("force-opaques interior key regions when preserveInterior=true", async () => {
    const W = 32;
    const H = 32;
    const rgba = new Uint8Array(W * H * 4);
    // Pure green field
    for (let p = 0, i = 0; p < W * H; p++, i += 4) {
      rgba[i] = 0;
      rgba[i + 1] = 255;
      rgba[i + 2] = 0;
      rgba[i + 3] = 255;
    }
    // Yellow body
    for (let y = 8; y < 24; y++) {
      for (let x = 8; x < 24; x++) {
        const i = (y * W + x) * 4;
        rgba[i] = 220;
        rgba[i + 1] = 200;
        rgba[i + 2] = 60;
      }
    }
    // Interior green hole in the body
    for (let y = 14; y < 18; y++) {
      for (let x = 14; x < 18; x++) {
        const i = (y * W + x) * 4;
        rgba[i] = 0;
        rgba[i + 1] = 255;
        rgba[i + 2] = 0;
      }
    }

    const aggressive = await chromaMask(rgba, W, H, { key: "#00ff00" });
    const preserved = await chromaMask(rgba, W, H, {
      key: "#00ff00",
      preserveInterior: true,
    });
    const center = 16 * W + 16;
    expect(aggressive.alpha[center]).toBe(0);
    expect(preserved.alpha[center]).toBe(255);
  });
});

describe("chromaMask: I/O fixture wiring", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-mask-io-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("noisy-bg fixture: producer runs cleanly with auto key", async () => {
    const res = await chromaMaskFromFile({ in: fixture("noisy-bg.png") });
    expect(res.stats.key).toMatch(/^#[0-9a-f]{6}$/);
    expect(res.width).toBeGreaterThan(0);
    expect(res.height).toBeGreaterThan(0);
  });

  it("synthesized PNG: auto-detects close to pure green and removes most of the frame", async () => {
    const W = 48;
    const H = 48;
    const rgba = new Uint8Array(W * H * 4);
    for (let p = 0, i = 0; p < W * H; p++, i += 4) {
      rgba[i] = 0;
      rgba[i + 1] = 255;
      rgba[i + 2] = 0;
      rgba[i + 3] = 255;
    }
    for (let y = 16; y < 32; y++) {
      for (let x = 16; x < 32; x++) {
        const i = (y * W + x) * 4;
        rgba[i] = 220;
        rgba[i + 1] = 0;
        rgba[i + 2] = 0;
      }
    }
    const file = path.join(tmp, "synth.png");
    await writeRawPng(file, W, H, rgba);
    const res = await chromaMaskFromFile({ in: file, key: "auto" });
    // 16x16 subject inside 48x48 canvas → 1 − (16/48)² ≈ 0.889 removed.
    expect(res.stats.removedFraction).toBeGreaterThan(0.85);
    expect(res.stats.removedFraction).toBeLessThan(0.92);
  });
});
