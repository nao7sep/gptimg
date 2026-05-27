/**
 * Replace chroma-key spill on the cutout boundary with nearby foreground color.
 *
 * Alpha solves the shape; RGB solves compositing quality. For pixels on the
 * boundary, especially low-alpha antialias pixels, the original RGB often still
 * contains the green backdrop. Projecting that green away can create black or
 * gray halos. Instead, sample nearby opaque, non-key-dominant subject pixels and
 * use their color as the foreground estimate for the edge.
 */
export function despill(
  rgba: Uint8Array,
  width: number,
  height: number,
  alpha: Uint8Array,
  keyHex: string,
  band?: Uint8Array,
): void {
  const keyRgb = parseHex(keyHex);
  const source = new Uint8Array(rgba);

  for (let p = 0, i = 0; p < width * height; p++, i += 4) {
    const a = alpha[p]!;
    if (a === 0) continue;
    const inBand = band?.[p] !== undefined && band[p]! > 0;
    const keyDominant = isKeyDominant(source[i]!, source[i + 1]!, source[i + 2]!, keyRgb);
    if (!inBand && a === 255 && !keyDominant) continue;

    const foreground = sampleForegroundColor(source, alpha, width, height, p, keyRgb);
    if (!foreground) continue;

    const amount = a < 255 || keyDominant ? 1 : 0.35;
    rgba[i] = mix(source[i]!, foreground[0], amount);
    rgba[i + 1] = mix(source[i + 1]!, foreground[1], amount);
    rgba[i + 2] = mix(source[i + 2]!, foreground[2], amount);
  }
}

function sampleForegroundColor(
  rgba: Uint8Array,
  alpha: Uint8Array,
  width: number,
  height: number,
  pixel: number,
  keyRgb: [number, number, number],
): [number, number, number] | null {
  const x = pixel % width;
  const y = Math.floor(pixel / width);
  let weightTotal = 0;
  let r = 0;
  let g = 0;
  let b = 0;

  for (let radius = 1; radius <= 8; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const n = ny * width + nx;
        if (alpha[n]! < 240) continue;
        const offset = n * 4;
        if (isKeyDominant(rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!, keyRgb)) {
          continue;
        }
        const weight = 1 / Math.max(1, Math.hypot(dx, dy));
        weightTotal += weight;
        r += rgba[offset]! * weight;
        g += rgba[offset + 1]! * weight;
        b += rgba[offset + 2]! * weight;
      }
    }
    if (weightTotal > 0) {
      return [
        Math.round(r / weightTotal),
        Math.round(g / weightTotal),
        Math.round(b / weightTotal),
      ];
    }
  }
  return null;
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

function mix(from: number, to: number, amount: number): number {
  return Math.round(from * (1 - amount) + to * amount);
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}
