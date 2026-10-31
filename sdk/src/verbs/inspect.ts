import { verbDone, verbStart } from "../events/index.ts";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { Metadata } from "sharp";
import sharp from "../image/sharp.ts";
import type { SdkContext } from "../context.ts";
import { GptImgError, fsError, throwIfAborted } from "../errors.ts";
import { inputImageError } from "../image/bridge.ts";
import { FORMAT_TO_EXT } from "../image/formats.ts";
import { withVerbLogger } from "../internal/local-verb.ts";
import type { RefusedResult } from "../refusal.ts";
import { readSidecar, sidecarPathBeside } from "../sidecar/read.ts";
import type { InspectArgs, InspectRecord, InspectResult } from "../types.ts";
import type { VerbCallOptions } from "./options.ts";
import { validateInspectArgs } from "./schemas.ts";

// Extensions that also name each format, beyond the canonical one in FORMAT_TO_EXT.
const EXTENSION_ALIASES: Readonly<Record<string, readonly string[]>> = {
  jpeg: ["jpeg", "jpe"],
  tiff: ["tif"],
  heif: ["heic", "hif"],
};

// Bits per sample for each libvips pixel format sharp reports as `depth`.
const DEPTH_BITS: Readonly<Record<string, number>> = {
  uchar: 8,
  char: 8,
  ushort: 16,
  short: 16,
  uint: 32,
  int: 32,
  float: 32,
  complex: 64,
  double: 64,
  dpcomplex: 128,
};

/**
 * What an image is, in one call per file, for a consumer choosing what to run
 * on it: its format as the bytes say (and whether the extension agrees), its
 * size and channels, whether any pixel is translucent, and the sidecar beside
 * it. It reads the header and the sidecar; only an image with an alpha channel
 * is decoded, to tell whether it is opaque. Content bounds belong to
 * `framecheck`, residue to `keycheck`, and checking the sidecar against the
 * image to `verify`.
 */
export async function inspectImpl(
  ctx: SdkContext,
  args: InspectArgs,
  opts: VerbCallOptions = {},
): Promise<InspectResult | RefusedResult> {
  validateInspectArgs(args);
  const input = args.in;

  return withVerbLogger(ctx, "inspect", opts, async (logger) => {
    throwIfAborted(opts.signal);
    logger.emit("info", "resolve", verbStart({ input }));
    let fileBytes: number;
    try {
      fileBytes = (await stat(input)).size;
    } catch (err) {
      throw fsError(err, "Failed to read image", input);
    }
    let meta: Metadata;
    try {
      meta = await sharp(input).metadata();
    } catch (err) {
      throw inputImageError(err, "inspect: failed to read", input);
    }
    if (!meta.format || !(meta.width > 0) || !(meta.height > 0)) {
      throw new GptImgError("image.noContent", `inspect: could not determine the format and size of ${input}.`, { subject: input });
    }

    throwIfAborted(opts.signal);
    let opaque = true;
    if (meta.hasAlpha) {
      try {
        opaque = (await sharp(input).stats()).isOpaque;
      } catch (err) {
        throw inputImageError(err, "inspect: failed to decode", input);
      }
    }

    throwIfAborted(opts.signal);
    const record = await recordBeside(input);

    const extension = path.extname(input).slice(1).toLowerCase();
    const canonical = FORMAT_TO_EXT[meta.format] ?? meta.format;
    const extensionMatches = extension === canonical || (EXTENSION_ALIASES[meta.format] ?? []).includes(extension);
    const result: InspectResult = {
      status: "completed",
      input,
      fileBytes,
      format: meta.format,
      extensionMatches,
      width: meta.width,
      height: meta.height,
      channels: meta.channels,
      hasAlpha: meta.hasAlpha,
      opaque,
      bitDepth: meta.bitsPerSample ?? DEPTH_BITS[meta.depth] ?? 8,
      colorSpace: meta.space,
      density: meta.density ?? null,
      orientation: meta.orientation ?? null,
      pages: meta.pages ?? 1,
      record,
    };
    logger.emit("info", "stats", verbDone({
      format: result.format,
      extensionMatches,
      width: result.width,
      height: result.height,
      opaque,
      record: record?.status ?? null,
    }));
    return result;
  });
}

/** The sidecar beside an image as read, without checking it against the image. */
async function recordBeside(imagePath: string): Promise<InspectRecord | null> {
  const sidecarPath = sidecarPathBeside(imagePath);
  if (!existsSync(sidecarPath)) return null;
  try {
    const sidecar = await readSidecar(sidecarPath);
    const chroma = (sidecar.request as { chroma?: { color?: unknown } }).chroma?.color;
    return {
      path: sidecarPath,
      status: "readable",
      operation: sidecar.operation,
      chromaKey: typeof chroma === "string" ? chroma : null,
    };
  } catch (err) {
    if (!(err instanceof GptImgError)) throw err;
    return { path: sidecarPath, status: "unreadable", code: err.code, message: err.message };
  }
}
