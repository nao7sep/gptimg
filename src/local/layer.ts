/**
 * Layer: alpha source-over composite of a top RGBA image onto a base RGBA
 * image. Used for placing a trimmed cutout/content layer on top of a backplate
 * in the icon-composition pipeline:
 *
 *   backplate … → layer({ base: <plate>, top: <content>, scale: 0.78 })
 *
 * The output is always the base's size — `layer` never resizes the canvas. The
 * top is placed by `gravity` (default center) or an explicit `topOffset`, and
 * **clipped to the base canvas**: a top larger than the base (`scale > 1`, an
 * oversized native top, or a `topOffset` running off the edge) simply bleeds
 * past the edges, which is the natural full-bleed behavior. The only invalid
 * placement is one that lands the top entirely outside the base.
 *
 * `compose({ over: <image> })` is *not* a substitute: it flattens to opaque RGB
 * driven by a single-channel mask. `layer` does a proper alpha composite of
 * two RGBA images and preserves the base's transparency outside the top.
 */

import sharp from "sharp";
import { LocalOpError, toAbortError } from "../errors.js";
import type { LayerGravity, LayerOffset } from "../types.js";

export const LAYER_DEFAULTS = {
  gravity: "center" as LayerGravity,
} as const;

/**
 * Largest top-image side we will materialize from a `scale`. Removing the old
 * "top must fit the base" check also removed the implicit upper bound on
 * `scale`, so an unbounded `scale` could balloon a small input into an OOM.
 * Mirrors RESIZE_MAX_TO_SIZE — the ceiling on a single allocated side.
 */
const LAYER_MAX_TOP = 16384;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw toAbortError(signal.reason);
}

/**
 * Top-left pixel where a `topW × topH` overlay anchors on a `baseW × baseH`
 * canvas for a compass gravity. Replaces sharp's own gravity placement so the
 * gravity and explicit-offset paths share one clip step below. When the top is
 * larger than the base the coordinate goes negative (the top bleeds off that
 * edge), which the clip then trims — e.g. `center` with an oversized top bleeds
 * equally on all sides.
 */
function gravityToTopLeft(
  gravity: LayerGravity,
  baseW: number,
  baseH: number,
  topW: number,
  topH: number,
): { x: number; y: number } {
  let x: number;
  if (gravity === "west" || gravity === "northwest" || gravity === "southwest") {
    x = 0;
  } else if (gravity === "east" || gravity === "northeast" || gravity === "southeast") {
    x = baseW - topW;
  } else {
    x = Math.round((baseW - topW) / 2);
  }
  let y: number;
  if (gravity === "north" || gravity === "northeast" || gravity === "northwest") {
    y = 0;
  } else if (gravity === "south" || gravity === "southeast" || gravity === "southwest") {
    y = baseH - topH;
  } else {
    y = Math.round((baseH - topH) / 2);
  }
  return { x, y };
}

export interface LayerRunArgs {
  base: string;
  top: string;
  out: string;
  /** Resize top so its longer side = scale * min(baseW, baseH). */
  scale?: number;
  gravity?: LayerGravity;
  topOffset?: LayerOffset;
}

export interface LayerRunResult {
  output: string;
  width: number;
  height: number;
  topWidth: number;
  topHeight: number;
  gravity: LayerGravity | null;
  topOffset: LayerOffset | null;
}

async function readMetadata(filePath: string): Promise<{
  width: number;
  height: number;
}> {
  let meta;
  try {
    meta = await sharp(filePath).metadata();
  } catch (err) {
    throw new LocalOpError(
      "image.decodeFailed",
      `layer: failed to read ${filePath}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  if (
    typeof meta.width !== "number" ||
    typeof meta.height !== "number" ||
    meta.width <= 0 ||
    meta.height <= 0
  ) {
    throw new LocalOpError(
      "image.noContent",
      `layer: could not determine dimensions of ${filePath}.`,
    );
  }
  return { width: meta.width, height: meta.height };
}

export async function runLayer(
  args: LayerRunArgs,
  opts: { signal?: AbortSignal | undefined } = {},
): Promise<LayerRunResult> {
  const { signal } = opts;
  throwIfAborted(signal);

  const baseMeta = await readMetadata(args.base);
  throwIfAborted(signal);
  const topMeta = await readMetadata(args.top);
  throwIfAborted(signal);

  // Resize top to scale * min(base.shorter, ...) if requested. We preserve
  // aspect ratio explicitly above the resize call, then pass fit:"fill" so
  // sharp uses the integer pixel dimensions we computed without rounding.
  let topPipeline = sharp(args.top).ensureAlpha();
  let topWidth = topMeta.width;
  let topHeight = topMeta.height;
  if (args.scale !== undefined) {
    const targetLonger = Math.round(
      args.scale * Math.min(baseMeta.width, baseMeta.height),
    );
    if (targetLonger < 1) {
      throw new LocalOpError(
        "args.invalid",
        `layer: scale ${args.scale} on base ${baseMeta.width}x${baseMeta.height} resolves to < 1 px.`,
      );
    }
    if (targetLonger > LAYER_MAX_TOP) {
      throw new LocalOpError(
        "args.invalid",
        `layer: scale ${args.scale} on base ${baseMeta.width}x${baseMeta.height} resolves to ${targetLonger}px, over the ${LAYER_MAX_TOP}px cap.`,
      );
    }
    const aspect = topMeta.width / topMeta.height;
    if (topMeta.width >= topMeta.height) {
      topWidth = targetLonger;
      topHeight = Math.max(1, Math.round(targetLonger / aspect));
    } else {
      topHeight = targetLonger;
      topWidth = Math.max(1, Math.round(targetLonger * aspect));
    }
    topPipeline = topPipeline.resize(topWidth, topHeight, { fit: "fill" });
  }

  let topBuffer: Buffer;
  try {
    topBuffer = await topPipeline.png().toBuffer();
  } catch (err) {
    throw new LocalOpError(
      "image.writeFailed",
      `layer: failed to resize top ${args.top}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  throwIfAborted(signal);

  // Resolve a destination top-left for the top, from an explicit offset or from
  // the gravity anchor. Either may be negative or run past an edge — that means
  // the top bleeds off the canvas, which is allowed; the clip below trims it.
  let usedGravity: LayerGravity | null = null;
  let usedOffset: LayerOffset | null = null;
  let destX: number;
  let destY: number;
  if (args.topOffset !== undefined) {
    const { x, y } = args.topOffset;
    // Defensive: the schema enforces integers, but runLayer is also called
    // directly. A non-integer offset would desync from sharp's integer extract.
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      throw new LocalOpError(
        "args.invalid",
        `layer: topOffset (${x}, ${y}) must be integers.`,
      );
    }
    usedOffset = { x, y };
    destX = x;
    destY = y;
  } else {
    usedGravity = args.gravity ?? LAYER_DEFAULTS.gravity;
    ({ x: destX, y: destY } = gravityToTopLeft(
      usedGravity,
      baseMeta.width,
      baseMeta.height,
      topWidth,
      topHeight,
    ));
  }

  // Clip the placed top to the base. `src*` is the crop offset into the top,
  // `dst*` the (non-negative) composite offset on the base, `vis*` the visible
  // overlap. An empty overlap is the only invalid placement.
  const srcX = destX < 0 ? -destX : 0;
  const srcY = destY < 0 ? -destY : 0;
  const dstX = destX < 0 ? 0 : destX;
  const dstY = destY < 0 ? 0 : destY;
  const visW = Math.min(topWidth - srcX, baseMeta.width - dstX);
  const visH = Math.min(topHeight - srcY, baseMeta.height - dstY);
  if (visW <= 0 || visH <= 0) {
    throw new LocalOpError(
      "args.invalid",
      `layer: top ${topWidth}x${topHeight} placed at (${destX}, ${destY}) lands entirely outside base ${baseMeta.width}x${baseMeta.height}.`,
    );
  }

  // Crop the top to its visible region only when it actually bleeds; an
  // exactly-fitting top composites whole.
  let placed = topBuffer;
  if (srcX > 0 || srcY > 0 || visW < topWidth || visH < topHeight) {
    try {
      placed = await sharp(topBuffer)
        .extract({ left: srcX, top: srcY, width: visW, height: visH })
        .png()
        .toBuffer();
    } catch (err) {
      throw new LocalOpError(
        "image.writeFailed",
        `layer: failed to clip top ${args.top}: ${(err as Error).message}`,
        { cause: err },
      );
    }
    throwIfAborted(signal);
  }

  try {
    await sharp(args.base)
      .ensureAlpha()
      .composite([{ input: placed, left: dstX, top: dstY }])
      .png()
      .toFile(args.out);
  } catch (err) {
    throw new LocalOpError(
      "image.writeFailed",
      `layer: failed to write ${args.out}: ${(err as Error).message}`,
      { cause: err },
    );
  }

  return {
    output: args.out,
    width: baseMeta.width,
    height: baseMeta.height,
    topWidth,
    topHeight,
    gravity: usedGravity,
    topOffset: usedOffset,
  };
}
