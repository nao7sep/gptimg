import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildBackplateSvg,
  runBackplate,
} from "../../src/local/backplate.js";

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

function pixelAt(
  img: { data: Uint8Array; width: number },
  x: number,
  y: number,
): { r: number; g: number; b: number; a: number } {
  const i = (y * img.width + x) * 4;
  return {
    r: img.data[i]!,
    g: img.data[i + 1]!,
    b: img.data[i + 2]!,
    a: img.data[i + 3]!,
  };
}

describe("buildBackplateSvg", () => {
  it("uses a <rect> path with circular arcs in rect mode", () => {
    const svg = buildBackplateSvg({
      size: 100,
      content: 0.8,
      radius: 0.2,
      from: "#000000",
      to: "#ffffff",
      angle: 90,
      shape: "rect",
    });
    // Circular arcs (A) appear in the path data.
    expect(svg).toContain("A ");
    // Single SVG <path> element, gradient referenced.
    expect(svg).toMatch(/<path d="[^"]+" fill="url\(#g\)"\/>/);
    // No multi-sample squircle output (no long L-chain).
    const lCount = (svg.match(/ L /g) ?? []).length;
    expect(lCount).toBeLessThan(20);
  });

  it("uses a polyline approximation in squircle mode", () => {
    const svg = buildBackplateSvg({
      size: 100,
      content: 0.8,
      radius: 0.2,
      from: "#000000",
      to: "#ffffff",
      angle: 135,
      shape: "squircle",
    });
    // Squircle has no circular arcs.
    expect(svg).not.toContain("A ");
    // It instead has many "L" line segments per corner (~32 each × 4 corners).
    const lCount = (svg.match(/ L /g) ?? []).length;
    expect(lCount).toBeGreaterThan(100);
  });

  it("includes both gradient stops with the supplied hexes", () => {
    const svg = buildBackplateSvg({
      size: 100,
      content: 0.8,
      radius: 0.2,
      from: "#ff0000",
      to: "#0000ff",
      angle: 90,
      shape: "rect",
    });
    expect(svg).toContain('stop-color="#ff0000"');
    expect(svg).toContain('stop-color="#0000ff"');
  });
});

describe("runBackplate", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-backplate-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("renders a rect plate: center is gradient, corners are transparent", async () => {
    const out = path.join(tmp, "rect.png");
    const res = await runBackplate({
      out,
      size: 128,
      content: 0.8,
      radius: 0.2,
      from: "#ff0000",
      to: "#ff0000", // solid red for easy assertion
      angle: 90,
      shape: "rect",
    });
    expect(res.size).toBe(128);
    expect(res.shape).toBe("rect");
    expect(res.from).toBe("#ff0000");

    const img = await readRGBA(out);
    expect(img.width).toBe(128);
    expect(img.height).toBe(128);
    // Center pixel: inside the plate → opaque red.
    const c = pixelAt(img, 64, 64);
    expect(c.a).toBe(255);
    expect(c.r).toBe(255);
    expect(c.g).toBeLessThan(10);
    expect(c.b).toBeLessThan(10);
    // Corner pixel: outside the plate → transparent.
    const corner = pixelAt(img, 1, 1);
    expect(corner.a).toBe(0);
    // Far-edge pixel in the transparent padding: also transparent.
    const edge = pixelAt(img, 64, 5);
    expect(edge.a).toBe(0);
  });

  it("renders a squircle plate: center opaque, corners transparent", async () => {
    const out = path.join(tmp, "squircle.png");
    await runBackplate({
      out,
      size: 128,
      content: 0.8,
      radius: 0.225,
      from: "#3366ff",
      to: "#3366ff",
      angle: 90,
      shape: "squircle",
    });
    const img = await readRGBA(out);
    expect(pixelAt(img, 64, 64).a).toBe(255);
    expect(pixelAt(img, 1, 1).a).toBe(0);
  });

  it("respects the gradient angle: 0deg gradient goes bottom→top", async () => {
    const out = path.join(tmp, "vgrad.png");
    await runBackplate({
      out,
      size: 128,
      content: 1.0, // fill the whole canvas
      radius: 0,
      from: "#000000",
      to: "#ffffff",
      angle: 0,
      shape: "rect",
    });
    const img = await readRGBA(out);
    // Bottom row should be near black (gradient start).
    const bottom = pixelAt(img, 64, 120);
    expect(bottom.r).toBeLessThan(60);
    // Top row should be near white (gradient end).
    const top = pixelAt(img, 64, 8);
    expect(top.r).toBeGreaterThan(200);
  });

  it("respects --size", async () => {
    const out = path.join(tmp, "sized.png");
    const res = await runBackplate({
      out,
      size: 256,
      from: "#222222",
      to: "#444444",
    });
    expect(res.size).toBe(256);
    const img = await readRGBA(out);
    expect(img.width).toBe(256);
    expect(img.height).toBe(256);
  });

  it("renders correctly at a tiny size with radius=0 (no corner curve)", async () => {
    const out = path.join(tmp, "tiny.png");
    const res = await runBackplate({
      out,
      size: 16,
      content: 1.0,
      radius: 0,
      from: "#ff0000",
      to: "#ff0000",
      angle: 90,
      shape: "rect",
    });
    expect(res.size).toBe(16);
    const img = await readRGBA(out);
    expect(img.width).toBe(16);
    expect(img.height).toBe(16);
    // content=1, radius=0 → interior pixels are opaque red. Sample 2 px in
    // from each edge to avoid any antialiasing at integer-aligned boundaries.
    for (let y = 2; y <= 13; y += 4) {
      for (let x = 2; x <= 13; x += 4) {
        const p = pixelAt(img, x, y);
        expect(p.a).toBe(255);
        expect(p.r).toBeGreaterThan(200);
      }
    }
  });

  it("squircle mid-edge samples are opaque (catches a hypothetically self-crossing path)", async () => {
    // A self-intersecting squircle path would leave unfilled gaps along the
    // straight edges between corners. Sample inside each edge well clear of
    // the corner curvature.
    const out = path.join(tmp, "squircle-mid.png");
    await runBackplate({
      out,
      size: 128,
      content: 0.8,
      radius: 0.225,
      from: "#ff0000",
      to: "#ff0000",
      angle: 90,
      shape: "squircle",
    });
    const img = await readRGBA(out);
    // Content rect occupies [13, 13]..[114, 114] (size=128 × content=0.8 centered).
    // Sample mid-top edge (well inside): (64, 16).
    expect(pixelAt(img, 64, 16).a).toBe(255);
    // Mid-bottom edge.
    expect(pixelAt(img, 64, 112).a).toBe(255);
    // Mid-left edge.
    expect(pixelAt(img, 16, 64).a).toBe(255);
    // Mid-right edge.
    expect(pixelAt(img, 112, 64).a).toBe(255);
  });

  it("rejects a bad hex with args.invalid", async () => {
    await expect(
      runBackplate({
        out: path.join(tmp, "x.png"),
        size: 64,
        from: "zzz",
        to: "#000000",
      }),
    ).rejects.toMatchObject({
      errorType: "localOp",
      code: "args.invalid",
    });
  });

  it("rejects an out-of-range size", async () => {
    await expect(
      runBackplate({
        out: path.join(tmp, "x.png"),
        size: 0,
        from: "#000000",
        to: "#ffffff",
      }),
    ).rejects.toMatchObject({ code: "args.invalid" });
    await expect(
      runBackplate({
        out: path.join(tmp, "x.png"),
        size: 100.5,
        from: "#000000",
        to: "#ffffff",
      }),
    ).rejects.toMatchObject({ code: "args.invalid" });
  });

  it("rejects an out-of-range content", async () => {
    await expect(
      runBackplate({
        out: path.join(tmp, "x.png"),
        content: 1.5,
        from: "#000000",
        to: "#ffffff",
      }),
    ).rejects.toMatchObject({ code: "args.invalid" });
  });

  it("rejects an out-of-range radius", async () => {
    await expect(
      runBackplate({
        out: path.join(tmp, "x.png"),
        radius: 0.7,
        from: "#000000",
        to: "#ffffff",
      }),
    ).rejects.toMatchObject({ code: "args.invalid" });
  });
});
