import { loadRawRGBA, writeRGBA } from "../../image/bridge.js";
import type { ChromaAlphaVerifyResult } from "../../types.js";

interface VerifyAlphaOptions {
  key: string;
  preserveInterior: boolean;
  expectInteriorTransparency: boolean;
}

interface Component {
  area: number;
  touchesBorder: boolean;
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function isKeyDominant(
  r: number,
  g: number,
  b: number,
  keyRgb: [number, number, number],
): boolean {
  const rgb = [r, g, b];
  const keyMax = Math.max(...keyRgb);
  return keyRgb.some((v, i) => {
    if (v !== keyMax || keyMax < 128) return false;
    const other1 = rgb[(i + 1) % 3]!;
    const other2 = rgb[(i + 2) % 3]!;
    return rgb[i]! > other1 + 12 && rgb[i]! > other2 + 12;
  });
}

function transparentComponents(alpha: Uint8Array, width: number, height: number): Component[] {
  const seen = new Uint8Array(alpha.length);
  const components: Component[] = [];
  for (let start = 0; start < alpha.length; start++) {
    if (alpha[start]! > 5 || seen[start]) continue;
    const queue = [start];
    seen[start] = 1;
    let area = 0;
    let touchesBorder = false;
    for (let q = 0; q < queue.length; q++) {
      const idx = queue[q]!;
      area++;
      const x = idx % width;
      const y = Math.floor(idx / width);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        touchesBorder = true;
      }
      const neighbors = [
        x > 0 ? idx - 1 : -1,
        x + 1 < width ? idx + 1 : -1,
        y > 0 ? idx - width : -1,
        y + 1 < height ? idx + width : -1,
      ];
      for (const next of neighbors) {
        if (next < 0 || seen[next] || alpha[next]! > 5) continue;
        seen[next] = 1;
        queue.push(next);
      }
    }
    components.push({ area, touchesBorder });
  }
  return components;
}

function isNearTransparent(alpha: Uint8Array, idx: number, width: number, height: number): boolean {
  const x = idx % width;
  const y = Math.floor(idx / width);
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (alpha[ny * width + nx]! <= 5) return true;
    }
  }
  return false;
}

export async function verifyChromaAlpha(
  imagePath: string,
  opts: VerifyAlphaOptions,
): Promise<ChromaAlphaVerifyResult> {
  const raw = await loadRawRGBA(imagePath);
  const alpha = new Uint8Array(raw.width * raw.height);
  for (let p = 0, i = 3; p < alpha.length; p++, i += 4) alpha[p] = raw.data[i]!;

  const components = transparentComponents(alpha, raw.width, raw.height);
  const borderTransparentArea = components
    .filter((c) => c.touchesBorder)
    .reduce((acc, c) => acc + c.area, 0);
  const interiorTransparentArea = components
    .filter((c) => !c.touchesBorder)
    .reduce((acc, c) => acc + c.area, 0);

  const keyRgb = parseHex(opts.key);
  let partialAlphaPixels = 0;
  let boundaryPixels = 0;
  let boundaryKeyDominantPixels = 0;
  for (let p = 0, i = 0; p < alpha.length; p++, i += 4) {
    const a = alpha[p]!;
    if (a > 0 && a < 255) partialAlphaPixels++;
    if (a <= 5 || !isNearTransparent(alpha, p, raw.width, raw.height)) continue;
    boundaryPixels++;
    if (isKeyDominant(raw.data[i]!, raw.data[i + 1]!, raw.data[i + 2]!, keyRgb)) {
      boundaryKeyDominantPixels++;
    }
  }

  const boundaryKeyDominantRatio =
    boundaryPixels > 0 ? boundaryKeyDominantPixels / boundaryPixels : 0;
  const reasons: string[] = [];
  if (borderTransparentArea === 0) reasons.push("No transparent border background was detected");
  if (partialAlphaPixels === 0) reasons.push("No partial-alpha pixels were detected for smooth edges");
  if (opts.expectInteriorTransparency && interiorTransparentArea === 0) {
    const desc = opts.preserveInterior ? "with --preserve-interior off" : "without --preserve-interior";
    reasons.push(`an interior region was removed ${desc} but no interior transparent area was detected`);
  }
  if (boundaryKeyDominantRatio > 0.5) {
    reasons.push(
      `Key-colored spill remains on ${(boundaryKeyDominantRatio * 100).toFixed(1)}% of near-boundary pixels`,
    );
  }

  return {
    ok: reasons.length === 0,
    score: Math.max(0, 1 - boundaryKeyDominantRatio),
    reasons,
    metrics: {
      transparentComponentCount: components.length,
      borderTransparentArea,
      interiorTransparentArea,
      partialAlphaPixels,
      boundaryPixels,
      boundaryKeyDominantPixels,
      boundaryKeyDominantRatio,
    },
  };
}

export async function writeCheckerboardPreview(
  imagePath: string,
  outPath: string,
): Promise<string> {
  const raw = await loadRawRGBA(imagePath);
  const out = new Uint8Array(raw.width * raw.height * 4);
  const cell = 24;
  for (let y = 0; y < raw.height; y++) {
    for (let x = 0; x < raw.width; x++) {
      const i = (y * raw.width + x) * 4;
      const bg = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? 224 : 176;
      const a = raw.data[i + 3]! / 255;
      out[i] = Math.round(raw.data[i]! * a + bg * (1 - a));
      out[i + 1] = Math.round(raw.data[i + 1]! * a + bg * (1 - a));
      out[i + 2] = Math.round(raw.data[i + 2]! * a + bg * (1 - a));
      out[i + 3] = 255;
    }
  }
  await writeRGBA(out, raw.width, raw.height, outPath);
  return outPath;
}
