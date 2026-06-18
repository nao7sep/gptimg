/**
 * Layer: alpha source-over composite of a top RGBA image onto a base RGBA
 * image. Used for placing a trimmed cutout/content layer on top of a backplate
 * in the icon-composition pipeline:
 *
 *   backplate … → layer({ base: <plate>, top: <content>, scale: 0.78 })
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw toAbortError(signal.reason);
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

  // The composite must fit within the base. sharp would otherwise reject with
  // a "composite image dimensions exceed input" message we'd wrap as a
  // misleading image.writeFailed. Catch it here with a clear arg-level error.
  if (topWidth > baseMeta.width || topHeight > baseMeta.height) {
    throw new LocalOpError(
      "args.invalid",
      `layer: top ${topWidth}x${topHeight} exceeds base ${baseMeta.width}x${baseMeta.height}; reduce scale or use a smaller top.`,
    );
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

  // Build the composite op. Either gravity-anchored or explicit pixel offset.
  let usedGravity: LayerGravity | null = null;
  let usedOffset: LayerOffset | null = null;
  let composite;
  if (args.topOffset !== undefined) {
    const { x, y } = args.topOffset;
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      y < 0 ||
      x + topWidth > baseMeta.width ||
      y + topHeight > baseMeta.height
    ) {
      throw new LocalOpError(
        "args.invalid",
        `layer: topOffset (${x}, ${y}) places top ${topWidth}x${topHeight} outside base ${baseMeta.width}x${baseMeta.height}.`,
      );
    }
    usedOffset = { x, y };
    composite = { input: topBuffer, left: x, top: y };
  } else {
    usedGravity = args.gravity ?? LAYER_DEFAULTS.gravity;
    composite = { input: topBuffer, gravity: usedGravity };
  }

  try {
    await sharp(args.base)
      .ensureAlpha()
      .composite([composite])
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
