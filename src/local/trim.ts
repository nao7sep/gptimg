/**
 * Trim: crop an RGBA image to its alpha bounding box and re-pad by a relative
 * margin. Optionally extend the shorter axis with transparent pixels so the
 * output is square (useful when feeding the result into the icon pipeline,
 * which expects a square content layer for the squircle backplate).
 *
 * "Relative" margin = a fraction of the longer bbox side. This gives every
 * stamp/icon the same *visual* breathing room regardless of raw subject size.
 *
 * Because the crop box is the extent of *any* non-zero alpha, faint keying
 * residue (a sub-visible wash or stray speckles left when a chroma/AI matte is
 * not despeckled) silently inflates it and shoves the subject off-centre.
 * `trim` does not fix that — cleaning the matte is `despeckle`'s job — but it
 * does *detect* it: it compares the crop box against the solid-subject box and
 * flags `residueSuspected`, so a forgotten `despeckle` surfaces at the step it
 * breaks rather than as a mysteriously off-centre asset later.
 */

import sharp from "sharp";
import { LocalOpError, toAbortError } from "../errors.js";
import { loadRawRGBA } from "../image/bridge.js";
import type { AlphaBBox } from "../types.js";

export const TRIM_DEFAULTS = {
  margin: 0.08,
  square: false,
} as const;

/**
 * Alpha at/above which a pixel counts as "solid subject" rather than an
 * anti-aliased edge or faint keying residue. Used only by the residue check;
 * it never affects the crop, which keys off any non-zero alpha.
 */
const SOLID_ALPHA = 128;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw toAbortError(signal.reason);
}

/**
 * Tightest rect of pixels whose alpha is at least `minAlpha`. With the default
 * (`1`) that is the any-non-zero-alpha box `trim` crops to; pass a higher level
 * (e.g. `SOLID_ALPHA`) to get the solid-subject box. Returns null when no pixel
 * qualifies. Linear scan, O(width * height).
 */
export function computeAlphaBBox(
  rgba: Uint8Array,
  width: number,
  height: number,
  minAlpha = 1,
): AlphaBBox | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const a = rgba[(row + x) * 4 + 3]!;
      if (a >= minAlpha) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Per-side overhang (px ≥ 0) of the crop box beyond the solid-subject box. */
export interface BBoxOverhang {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ResidueCheck {
  /** Solid-subject (alpha ≥ SOLID_ALPHA) box; null if nothing is solid. */
  solidBBox: AlphaBBox | null;
  /** How far the crop box overhangs the solid box on each side. */
  overhang: BBoxOverhang;
  /** Overhang beyond this many px reads as residue, not an anti-aliased edge. */
  tolerance: number;
  /** True when the crop box overhangs the solid subject beyond `tolerance`. */
  residueSuspected: boolean;
}

/**
 * Compare the crop box (any-alpha) against the solid-subject box. A crop box
 * that reaches well past the solid subject is the signature of un-despeckled
 * keying residue (a faint wash / stray speckles inflating the any-alpha extent).
 * `tolerance` absorbs the legitimate anti-aliased edge (sub-1% of the larger
 * dimension, floored at 2px); overhang beyond it is flagged.
 */
function detectResidue(
  rgba: Uint8Array,
  width: number,
  height: number,
  cropBBox: AlphaBBox,
): ResidueCheck {
  const solidBBox = computeAlphaBBox(rgba, width, height, SOLID_ALPHA);
  const tolerance = Math.max(2, Math.ceil(0.01 * Math.max(width, height)));
  if (!solidBBox) {
    return {
      solidBBox: null,
      overhang: { left: 0, top: 0, right: 0, bottom: 0 },
      tolerance,
      residueSuspected: false,
    };
  }
  const overhang: BBoxOverhang = {
    left: Math.max(0, solidBBox.x - cropBBox.x),
    top: Math.max(0, solidBBox.y - cropBBox.y),
    right: Math.max(0, cropBBox.x + cropBBox.width - (solidBBox.x + solidBBox.width)),
    bottom: Math.max(0, cropBBox.y + cropBBox.height - (solidBBox.y + solidBBox.height)),
  };
  const maxOverhang = Math.max(overhang.left, overhang.top, overhang.right, overhang.bottom);
  return { solidBBox, overhang, tolerance, residueSuspected: maxOverhang > tolerance };
}

export interface TrimRunArgs {
  in: string;
  out: string;
  margin?: number;
  square?: boolean;
}

export interface TrimRunResult {
  output: string;
  bbox: AlphaBBox;
  margin: number;
  marginPx: number;
  width: number;
  height: number;
  square: boolean;
  /** Solid-subject box; null when no pixel is solid (alpha ≥ 128). */
  solidBBox: AlphaBBox | null;
  /** Per-side overhang of the crop box beyond the solid box. */
  overhang: BBoxOverhang;
  /** Overhang threshold (px) above which residue is suspected. */
  tolerance: number;
  /** True when un-despeckled keying residue likely inflated the crop box. */
  residueSuspected: boolean;
}

export async function runTrim(
  args: TrimRunArgs,
  opts: { signal?: AbortSignal | undefined } = {},
): Promise<TrimRunResult> {
  const { signal } = opts;
  throwIfAborted(signal);

  const margin = args.margin ?? TRIM_DEFAULTS.margin;
  const square = args.square ?? TRIM_DEFAULTS.square;

  const { data, width, height } = await loadRawRGBA(args.in);
  throwIfAborted(signal);
  const bbox = computeAlphaBBox(data, width, height);
  if (!bbox) {
    throw new LocalOpError(
      "image.noContent",
      `trim: ${args.in} is fully transparent; nothing to crop.`,
    );
  }

  const residue = detectResidue(data, width, height, bbox);

  const marginPx = Math.round(margin * Math.max(bbox.width, bbox.height));
  let padTop = marginPx;
  let padBottom = marginPx;
  let padLeft = marginPx;
  let padRight = marginPx;
  if (square) {
    const contentW = bbox.width + 2 * marginPx;
    const contentH = bbox.height + 2 * marginPx;
    const finalSize = Math.max(contentW, contentH);
    const extraW = finalSize - contentW;
    const extraH = finalSize - contentH;
    padLeft += Math.floor(extraW / 2);
    padRight += Math.ceil(extraW / 2);
    padTop += Math.floor(extraH / 2);
    padBottom += Math.ceil(extraH / 2);
  }

  const finalW = bbox.width + padLeft + padRight;
  const finalH = bbox.height + padTop + padBottom;

  try {
    const pipeline = sharp(args.in).extract({
      left: bbox.x,
      top: bbox.y,
      width: bbox.width,
      height: bbox.height,
    });
    if (padLeft || padRight || padTop || padBottom) {
      pipeline.extend({
        top: padTop,
        bottom: padBottom,
        left: padLeft,
        right: padRight,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      });
    }
    await pipeline.png().toFile(args.out);
  } catch (err) {
    throw new LocalOpError(
      "image.writeFailed",
      `trim: failed to write ${args.out}: ${(err as Error).message}`,
      { cause: err },
    );
  }

  return {
    output: args.out,
    bbox,
    margin,
    marginPx,
    width: finalW,
    height: finalH,
    square,
    solidBBox: residue.solidBBox,
    overhang: residue.overhang,
    tolerance: residue.tolerance,
    residueSuspected: residue.residueSuspected,
  };
}
