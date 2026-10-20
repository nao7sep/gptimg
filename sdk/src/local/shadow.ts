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

import sharp from "../image/sharp.ts";
import { normalizeHex, parseHex } from "../color.ts";
import { processingError, throwIfAborted } from "../errors.ts";
import { decodeImage, inputImageError, loadRawRGBA, writeImageFile } from "../image/bridge.ts";
import type { EncodingArgs, ShadowOffset } from "../types.ts";

export const SHADOW_DEFAULTS = {
  blur: 12,
  offset: { x: 0, y: 8 } as ShadowOffset,
  color: "#000000",
  opacity: 0.35,
  spread: 0,
  keepCanvas: false,
} as const;

export interface ShadowRunArgs extends EncodingArgs {
  in: string;
  out: string;
  /** Replace an existing file at `out`; otherwise publication is no-clobber. */
  overwrite?: boolean;
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
 * Max over each window of `2r + 1` samples centred on every position of a 1-D
 * line read at `offset + i * stride`, with samples beyond the line counted as 0
 * (alpha is never negative, so that equals clamping the window). Van Herk /
 * Gil-Werman: block-wise prefix and suffix maxima make the cost independent
 * of `r`, which has no upper bound. `g` and `h` are scratch arrays of length
 * at least `n + 2r`.
 */
function slidingMaxLine(
  src: Uint8Array,
  dst: Uint8Array,
  offset: number,
  stride: number,
  n: number,
  r: number,
  g: Uint8Array,
  h: Uint8Array,
): void {
  const k = 2 * r + 1;
  const len = n + 2 * r;
  const at = (i: number): number => {
    const x = i - r;
    return x >= 0 && x < n ? src[offset + x * stride]! : 0;
  };
  for (let i = 0; i < len; i++) {
    const v = at(i);
    g[i] = i % k === 0 ? v : Math.max(g[i - 1]!, v);
  }
  for (let i = len - 1; i >= 0; i--) {
    const v = at(i);
    h[i] = i === len - 1 || (i + 1) % k === 0 ? v : Math.max(h[i + 1]!, v);
  }
  for (let x = 0; x < n; x++) {
    dst[offset + x * stride] = Math.max(h[x]!, g[x + 2 * r]!);
  }
}

/**
 * Square (Chebyshev) dilation of a single-channel buffer by `r` pixels, as two
 * separable max passes. sharp has no morphology primitive; this gives an exact,
 * predictable spread distance in time linear in the pixel count. Exported for
 * testing.
 */
export function dilateAlpha(
  src: Uint8Array,
  width: number,
  height: number,
  r: number,
  signal?: AbortSignal,
): Uint8Array {
  if (r <= 0) return src;
  const scratch = Math.max(width, height) + 2 * r;
  const g = new Uint8Array(scratch);
  const h = new Uint8Array(scratch);
  const horiz = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    throwIfAborted(signal);
    slidingMaxLine(src, horiz, y * width, 1, width, r, g, h);
  }
  const out = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    throwIfAborted(signal);
    slidingMaxLine(horiz, out, x, width, height, r, g, h);
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
  alpha = dilateAlpha(alpha, pw, ph, spread, signal);

  throwIfAborted(signal);
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
    subjectPng = await decodeImage(args.in).ensureAlpha().png().toBuffer();
  } catch (err) {
    throw inputImageError(err, "shadow: failed to render layers from", args.in);
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
    throw processingError(err, "shadow: failed to composite", args.in, "none");
  }
  throwIfAborted(signal);

  const finalPipe = keepCanvas
    ? decodeImage(composed).extract({ left: subjX, top: subjY, width: w, height: h })
    : decodeImage(composed);
  await writeImageFile({ path: args.out, overwrite: args.overwrite, source: args.in }, "shadow", args, () => finalPipe);

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
