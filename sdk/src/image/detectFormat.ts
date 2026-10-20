import sharp from "./sharp.ts";
import { GptImgError } from "../errors.ts";
import { FORMAT_TO_EXT } from "./formats.ts";

export interface DetectedFormat {
  format: string;
  extension: string;
  width?: number;
  height?: number;
}

export async function detectFormat(buf: Buffer | Uint8Array): Promise<DetectedFormat> {
  let meta;
  try {
    meta = await sharp(buf).metadata();
  } catch (err) {
    throw new GptImgError("image.undecodable", "Failed to decode image bytes", { cause: err });
  }
  const fmt = meta.format;
  if (!fmt) {
    throw new GptImgError("image.unsupportedFormat", "Could not determine image format from bytes");
  }
  return {
    format: fmt,
    extension: FORMAT_TO_EXT[fmt] ?? fmt,
    width: meta.width,
    height: meta.height,
  };
}
