/**
 * Shadow: cast a soft drop shadow from an RGBA image's alpha shape and
 * composite the original subject back on top. Serves two uses:
 *
 *   - depth on flat cutouts/stamps (fotoready)
 *   - a subtle lift under icon content before `icon` packs it
 *
 * Pipeline: extract alpha → optional spread (square dilation) → tint to the
 * shadow color at `opacity` → gaussian blur → composite shadow then subject
 * onto a transparent canvas. By default the canvas grows so the offset/blurred
 * shadow is never clipped; `keepCanvas` keeps the input size instead.
 */

import sharp from "sharp";
import { normalizeHex, parseHex } from "../color.js";
import { LocalOpError, toAbortError } from "../errors.js";
import { loadRawRGBA } from "../image/bridge.js";
import type { ShadowOffset } from "../types.js";

export const SHADOW_DEFAULTS = {
  blur: 12,
  offset: { x: 0, y: 8 } as ShadowOffset,
  color: "#000000",
  opacity: 0.35,
  spread: 0,
  keepCanvas: false,
} as const;

/** sharp's accepted gaussian blur sigma range; `0` means "no blur". */
const MIN_BLUR = 0.3;
const MAX_BLUR = 1000;

/** Upper bound on `spread` so padding can't explode the canvas into an OOM. */
const MAX_SPREAD = 1024;

/** Upper bound on |offset|, same reason: a huge offset would balloon the canvas. */
const MAX_OFFSET = 10000;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw toAbortError(signal.reason);
}

export interface ShadowRunArgs {
  in: string;
  out: string;
  blur?: number;
  offset?: ShadowOffset;
  color?: string;
  opacity?: number;
  spread?: number;
  keepCanvas?: boolean;
}

export interface ShadowRunResult {
  output: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  blur: number;
  offset: ShadowOffset;
  color: string;
  opacity: number;
  spread: number;
  keepCanvas: boolean;
}

/**
 * Square (Chebyshev) dilation of a single-channel buffer by `r` pixels, as two
 * separable max passes. sharp has no morphology primitive; this gives an exact,
 * predictable spread distance.
 */
function dilateAlpha(
  src: Uint8Array,
  width: number,
  height: number,
  r: number,
): Uint8Array {
  if (r <= 0) return src;
  const horiz = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(width - 1, x + r);
      let m = 0;
      for (let xi = x0; xi <= x1; xi++) {
        const v = src[row + xi]!;
        if (v > m) m = v;
        if (m === 255) break;
      }
      horiz[row + x] = m;
    }
  }
  const out = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(height - 1, y + r);
      let m = 0;
      for (let yi = y0; yi <= y1; yi++) {
        const v = horiz[yi * width + x]!;
        if (v > m) m = v;
        if (m === 255) break;
      }
      out[y * width + x] = m;
    }
  }
  return out;
}

export async function runShadow(
  args: ShadowRunArgs,
  opts: { signal?: AbortSignal | undefined } = {},
): Promise<ShadowRunResult> {
  const { signal } = opts;

  const blur = args.blur ?? SHADOW_DEFAULTS.blur;
  const offset = args.offset ?? SHADOW_DEFAULTS.offset;
  const color = normalizeHex(args.color ?? SHADOW_DEFAULTS.color, "--color");
  const opacity = args.opacity ?? SHADOW_DEFAULTS.opacity;
  const spread = args.spread ?? SHADOW_DEFAULTS.spread;
  const keepCanvas = args.keepCanvas ?? SHADOW_DEFAULTS.keepCanvas;

  if (!Number.isFinite(blur) || (blur !== 0 && (blur < MIN_BLUR || blur > MAX_BLUR))) {
    throw new LocalOpError(
      "args.invalid",
      `shadow: blur must be 0 or between ${MIN_BLUR} and ${MAX_BLUR}; got ${blur}.`,
    );
  }
  if (!Number.isInteger(offset.x) || !Number.isInteger(offset.y)) {
    throw new LocalOpError(
      "args.invalid",
      `shadow: offset must be integers; got (${offset.x}, ${offset.y}).`,
    );
  }
  if (Math.abs(offset.x) > MAX_OFFSET || Math.abs(offset.y) > MAX_OFFSET) {
    throw new LocalOpError(
      "args.invalid",
      `shadow: offset components must be within ±${MAX_OFFSET}; got (${offset.x}, ${offset.y}).`,
    );
  }
  if (!Number.isFinite(opacity) || opacity <= 0 || opacity > 1) {
    throw new LocalOpError(
      "args.invalid",
      `shadow: opacity must be in (0..1]; got ${opacity}.`,
    );
  }
  if (!Number.isInteger(spread) || spread < 0 || spread > MAX_SPREAD) {
    throw new LocalOpError(
      "args.invalid",
      `shadow: spread must be an integer in [0..${MAX_SPREAD}]; got ${spread}.`,
    );
  }

  throwIfAborted(signal);
  const src = await loadRawRGBA(args.in);
  const { width: w, height: h, data } = src;
  throwIfAborted(signal);

  // Pad the shadow canvas so dilation and blur never clip at the edges.
  const blurPad = blur > 0 ? Math.ceil(3 * blur) : 0;
  const pad = spread + blurPad;
  const pw = w + 2 * pad;
  const ph = h + 2 * pad;

  let alpha: Uint8Array = new Uint8Array(pw * ph);
  for (let y = 0; y < h; y++) {
    const dst = (y + pad) * pw + pad;
    for (let x = 0; x < w; x++) {
      alpha[dst + x] = data[(y * w + x) * 4 + 3]!;
    }
  }
  alpha = dilateAlpha(alpha, pw, ph, spread);

  const [cr, cg, cb] = parseHex(color);
  const shadowRGBA = Buffer.alloc(pw * ph * 4);
  for (let i = 0; i < pw * ph; i++) {
    const o = i * 4;
    shadowRGBA[o] = cr;
    shadowRGBA[o + 1] = cg;
    shadowRGBA[o + 2] = cb;
    shadowRGBA[o + 3] = Math.round(alpha[i]! * opacity);
  }

  let shadowPipe = sharp(shadowRGBA, { raw: { width: pw, height: ph, channels: 4 } });
  if (blur > 0) shadowPipe = shadowPipe.blur(blur);
  let shadowPng: Buffer;
  let subjectPng: Buffer;
  try {
    shadowPng = await shadowPipe.png().toBuffer();
    subjectPng = await sharp(args.in).ensureAlpha().png().toBuffer();
  } catch (err) {
    throw new LocalOpError(
      "image.writeFailed",
      `shadow: failed to render layers from ${args.in}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  throwIfAborted(signal);

  // Lay out subject and shadow in input-image coordinates, then shift so the
  // top-left of the union sits at (0, 0).
  const shadowX = offset.x - pad;
  const shadowY = offset.y - pad;
  const minX = Math.min(0, shadowX);
  const minY = Math.min(0, shadowY);
  const canvasW = Math.max(w, shadowX + pw) - minX;
  const canvasH = Math.max(h, shadowY + ph) - minY;
  const subjX = -minX;
  const subjY = -minY;

  let composed: Buffer;
  try {
    composed = await sharp({
      create: {
        width: canvasW,
        height: canvasH,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        { input: shadowPng, left: shadowX - minX, top: shadowY - minY },
        { input: subjectPng, left: subjX, top: subjY },
      ])
      .png()
      .toBuffer();
  } catch (err) {
    throw new LocalOpError(
      "image.writeFailed",
      `shadow: failed to composite ${args.in}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  throwIfAborted(signal);

  const finalPipe = keepCanvas
    ? sharp(composed).extract({ left: subjX, top: subjY, width: w, height: h })
    : sharp(composed);
  try {
    await finalPipe.png().toFile(args.out);
  } catch (err) {
    throw new LocalOpError(
      "image.writeFailed",
      `shadow: failed to write ${args.out}: ${(err as Error).message}`,
      { cause: err },
    );
  }

  return {
    output: args.out,
    width: keepCanvas ? w : canvasW,
    height: keepCanvas ? h : canvasH,
    sourceWidth: w,
    sourceHeight: h,
    blur,
    offset,
    color,
    opacity,
    spread,
    keepCanvas,
  };
}
