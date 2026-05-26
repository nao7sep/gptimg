import sharp from "sharp";
import { Image } from "image-js";

export interface RawImage {
  data: Uint8Array;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
}

export async function loadRawRGBA(path: string): Promise<RawImage> {
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8Array(data),
    width: info.width,
    height: info.height,
    channels: 4,
  };
}

export function rawRGBAToImageJs(raw: RawImage): Image {
  const colorModel = raw.channels === 4 ? "RGBA" : raw.channels === 3 ? "RGB" : "GREY";
  return new Image(raw.width, raw.height, { data: raw.data, colorModel });
}

/**
 * Wrap a binary mask (Uint8Array of 0 or 255 values, length = width*height)
 * as an image-js GREY Image. Use `.mask({ threshold: 0 })` on the result
 * to obtain a binary Mask suitable for ROI / morphology operations.
 */
export function uint8MaskToGreyImage(
  mask: Uint8Array,
  width: number,
  height: number,
): Image {
  return new Image(width, height, { data: mask, colorModel: "GREY" });
}

export async function writeRGBA(
  data: Uint8Array,
  width: number,
  height: number,
  outPath: string,
): Promise<void> {
  await sharp(Buffer.from(data), {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toFile(outPath);
}

/** Write a binary mask (0/255) as a single-channel PNG. */
export async function writeMaskPNG(
  mask: Uint8Array,
  width: number,
  height: number,
  outPath: string,
): Promise<void> {
  await sharp(Buffer.from(mask), {
    raw: { width, height, channels: 1 },
  })
    .png()
    .toFile(outPath);
}
