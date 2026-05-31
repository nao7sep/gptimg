/**
 * Apply a mask to an image and write the result.
 *
 *   compose(image, mask)              → RGBA with mask in the alpha channel
 *   compose(image, mask, over=#rgb)   → flatten over a solid color (RGB output)
 *   compose(image, mask, over=path)   → flatten over another image
 *
 * Optional `removeBleed <hex>` cleans a known background color out of the
 * subject pixels the mask kept. The algorithm dispatches on the hex's
 * chromaticity — they need different math:
 *
 *   Chromatic key (R/G/B/C/M/Y): spill suppression at every pixel the mask
 *   kept (α > 0), all alphas. For a primary key clamp the key channel to
 *   ≤ max(other two). For a secondary key reduce both non-suppressed
 *   channels by their excess above the suppressed channel. Legitimate
 *   subject colors satisfy these constraints; tainted pixels don't, and
 *   the clamp pulls them to neutral. No edge recovery — the compositing
 *   equation C = α·F + (1−α)·B is fragile for non-physical alphas (AI
 *   masks, even chroma-spill alphas under noise) and produces magenta or
 *   green halos when its subtraction goes negative.
 *
 *   Achromatic key (gray): can't suppress a hue that has none. Fall back
 *   to alpha-aware edge color recovery — solve C = α·F + (1−α)·B for F at
 *   partial-α pixels. This removes the gray blend baked into edge pixels
 *   during the original capture. Limited to partial-α; α=255 pixels are
 *   left alone (there's no "spill" to remove from a gray bg into a
 *   confidently-opaque subject pixel — at α=255 the bg contributed
 *   nothing).
 */

import { isHexColor, parseHex } from "../color.js";
import { LocalOpError, toAbortError } from "../errors.js";
import { loadMaskPNG, loadRawRGBA, writeRGBA } from "../image/bridge.js";
import {
  SRGB_TO_LINEAR_LUT,
  analyzeKey,
  linearToSRGBByte,
  linearizeRGBA,
} from "./chroma/spill.js";

export type ComposeOver =
  | { kind: "transparent" }
  | { kind: "color"; r: number; g: number; b: number }
  | { kind: "image"; path: string };

export interface ComposeArgs {
  in: string;
  mask: string;
  out: string;
  over?: ComposeOver;
  /** Background color to remove from subject pixels. See module doc. */
  removeBleed?: string;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw toAbortError(signal.reason);
}

export function parseOverColor(value: string): ComposeOver {
  if (isHexColor(value)) {
    const [r, g, b] = parseHex(value);
    return { kind: "color", r, g, b };
  }
  // Six bare hex digits is almost certainly a color with a forgotten "#" — fail
  // with that hint rather than silently treating it as an image path.
  if (/^[0-9a-fA-F]{6}$/.test(value)) {
    throw new LocalOpError(
      "args.invalid",
      `compose: --over "${value}" looks like a hex color but is missing the leading "#"; use "#${value}".`,
    );
  }
  return { kind: "image", path: value };
}

async function loadOverImage(
  path: string,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const img = await loadRawRGBA(path);
  if (img.width !== width || img.height !== height) {
    throw new LocalOpError(
      "image.sizeMismatch",
      `over-image size ${img.width}x${img.height} does not match input ${width}x${height}.`,
    );
  }
  return img.data;
}

export interface ComposeResult {
  output: string;
  width: number;
  height: number;
  over: ComposeOver["kind"];
}

/**
 * Per-pixel removeBleed. Mutates the linear-RGB buffers in place. Returns
 * nothing; the cleaned linear values are read out at composite time.
 *
 * Operates only on pixels with α > 0 (kept by the mask). Pure-α=0 pixels are
 * left alone — their output alpha is 0 and they're invisible anyway.
 */
function applyRemoveBleed(
  linR: Float32Array,
  linG: Float32Array,
  linB: Float32Array,
  maskAlpha: Uint8Array,
  bgHex: string,
  width: number,
  height: number,
): void {
  const [bgSR, bgSG, bgSB] = parseHex(bgHex);
  const bgR = SRGB_TO_LINEAR_LUT[bgSR]!;
  const bgG = SRGB_TO_LINEAR_LUT[bgSG]!;
  const bgB = SRGB_TO_LINEAR_LUT[bgSB]!;
  const topology = analyzeKey([bgR, bgG, bgB]);

  const n = width * height;
  for (let p = 0; p < n; p++) {
    const aByte = maskAlpha[p]!;
    if (aByte === 0) continue;
    let r = linR[p]!;
    let g = linG[p]!;
    let b = linB[p]!;

    if (topology !== null) {
      // Chromatic key — spill suppression on every kept pixel.
      if (topology.kind === "primary") {
        const ch = topology.channel;
        if (ch === 0) {
          const limit = g > b ? g : b;
          if (r > limit) r = limit;
        } else if (ch === 1) {
          const limit = r > b ? r : b;
          if (g > limit) g = limit;
        } else {
          const limit = r > g ? r : g;
          if (b > limit) b = limit;
        }
      } else {
        const sup = topology.suppressed;
        let supVal: number;
        let oA: number;
        let oB: number;
        if (sup === 0) {
          supVal = r;
          oA = g;
          oB = b;
        } else if (sup === 1) {
          supVal = g;
          oA = r;
          oB = b;
        } else {
          supVal = b;
          oA = r;
          oB = g;
        }
        const minOther = oA < oB ? oA : oB;
        if (minOther > supVal) {
          const excess = minOther - supVal;
          const newA = oA - excess;
          const newB = oB - excess;
          if (sup === 0) {
            g = newA < 0 ? 0 : newA;
            b = newB < 0 ? 0 : newB;
          } else if (sup === 1) {
            r = newA < 0 ? 0 : newA;
            b = newB < 0 ? 0 : newB;
          } else {
            r = newA < 0 ? 0 : newA;
            g = newB < 0 ? 0 : newB;
          }
        }
      }
    } else if (aByte < 255) {
      // Achromatic key — alpha-aware edge color recovery, partial-α only.
      const alpha = aByte / 255;
      // Floor on α — for very small α the inversion amplifies noise wildly
      // and the result is invisible anyway. Leave near-transparent pixels
      // as-is.
      if (alpha > 0.05) {
        const oneMinus = 1 - alpha;
        let fr = (r - oneMinus * bgR) / alpha;
        let fg = (g - oneMinus * bgG) / alpha;
        let fb = (b - oneMinus * bgB) / alpha;
        if (fr < 0) fr = 0;
        else if (fr > 1) fr = 1;
        if (fg < 0) fg = 0;
        else if (fg > 1) fg = 1;
        if (fb < 0) fb = 0;
        else if (fb > 1) fb = 1;
        r = fr;
        g = fg;
        b = fb;
      }
    }

    linR[p] = r;
    linG[p] = g;
    linB[p] = b;
  }
}

export async function runCompose(
  args: ComposeArgs,
  opts: { signal?: AbortSignal | undefined } = {},
): Promise<ComposeResult> {
  const { signal } = opts;
  throwIfAborted(signal);
  const image = await loadRawRGBA(args.in);
  throwIfAborted(signal);
  const mask = await loadMaskPNG(args.mask);
  if (mask.width !== image.width || mask.height !== image.height) {
    throw new LocalOpError(
      "image.sizeMismatch",
      `mask size ${mask.width}x${mask.height} does not match image ${image.width}x${image.height}.`,
    );
  }
  const { width, height, data: rgba } = image;
  const n = width * height;

  // Build the per-pixel "clean" sRGB byte source the compose loop reads from.
  // With removeBleed: lift to linear, apply removeBleed math, convert back
  // once. Without removeBleed: read the original sRGB bytes directly — no
  // roundtrip, no ±1/channel quantization drift on unchanged pixels.
  let getR: (p: number) => number;
  let getG: (p: number) => number;
  let getB: (p: number) => number;
  if (args.removeBleed) {
    const { linR, linG, linB } = linearizeRGBA(rgba);
    applyRemoveBleed(linR, linG, linB, mask.data, args.removeBleed, width, height);
    const cleanR = new Uint8Array(n);
    const cleanG = new Uint8Array(n);
    const cleanB = new Uint8Array(n);
    for (let p = 0; p < n; p++) {
      cleanR[p] = linearToSRGBByte(linR[p]!);
      cleanG[p] = linearToSRGBByte(linG[p]!);
      cleanB[p] = linearToSRGBByte(linB[p]!);
    }
    getR = (p) => cleanR[p]!;
    getG = (p) => cleanG[p]!;
    getB = (p) => cleanB[p]!;
  } else {
    getR = (p) => rgba[p * 4]!;
    getG = (p) => rgba[p * 4 + 1]!;
    getB = (p) => rgba[p * 4 + 2]!;
  }

  const over: ComposeOver = args.over ?? { kind: "transparent" };
  let overData: Uint8Array | null = null;
  if (over.kind === "image") {
    overData = await loadOverImage(over.path, width, height);
  }

  const out = new Uint8Array(n * 4);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const a = mask.data[p]!;
    const r = getR(p);
    const g = getG(p);
    const b = getB(p);
    if (over.kind === "transparent") {
      // Zero RGB where alpha=0 so a cutout carries no hidden background.
      // Alpha-honoring viewers are unaffected; alpha-ignoring renderers no
      // longer reveal the original background. Partial-α edge pixels keep
      // their RGB — that's the correct straight-alpha shape for compositing.
      if (a === 0) {
        out[i] = 0;
        out[i + 1] = 0;
        out[i + 2] = 0;
        out[i + 3] = 0;
      } else {
        out[i] = r;
        out[i + 1] = g;
        out[i + 2] = b;
        out[i + 3] = a;
      }
    } else if (over.kind === "color") {
      const t = a / 255;
      out[i] = Math.round(r * t + over.r * (1 - t));
      out[i + 1] = Math.round(g * t + over.g * (1 - t));
      out[i + 2] = Math.round(b * t + over.b * (1 - t));
      out[i + 3] = 255;
    } else {
      const t = a / 255;
      const bgR = overData![i]!;
      const bgG = overData![i + 1]!;
      const bgB = overData![i + 2]!;
      out[i] = Math.round(r * t + bgR * (1 - t));
      out[i + 1] = Math.round(g * t + bgG * (1 - t));
      out[i + 2] = Math.round(b * t + bgB * (1 - t));
      out[i + 3] = 255;
    }
  }

  throwIfAborted(signal);
  await writeRGBA(out, width, height, args.out);
  return { output: args.out, width, height, over: over.kind };
}
