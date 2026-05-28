import sharp from "sharp";
import { LocalOpError } from "../errors.js";

export interface RawImage {
  data: Uint8Array;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
}

export async function loadRawRGBA(path: string): Promise<RawImage> {
  let out;
  try {
    out = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch (err) {
    throw new LocalOpError(
      "image.decodeFailed",
      `Failed to decode image at ${path}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  const { data, info } = out;
  return {
    data: new Uint8Array(data),
    width: info.width,
    height: info.height,
    channels: 4,
  };
}

export async function writeRGBA(
  data: Uint8Array,
  width: number,
  height: number,
  outPath: string,
): Promise<void> {
  try {
    await sharp(Buffer.from(data), {
      raw: { width, height, channels: 4 },
    })
      .png()
      .toFile(outPath);
  } catch (err) {
    throw new LocalOpError(
      "image.writeFailed",
      `Failed to write image at ${outPath}: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

/** Write a binary mask (0/255) as a single-channel PNG. */
export async function writeMaskPNG(
  mask: Uint8Array,
  width: number,
  height: number,
  outPath: string,
): Promise<void> {
  try {
    await sharp(Buffer.from(mask), {
      raw: { width, height, channels: 1 },
    })
      .png()
      .toFile(outPath);
  } catch (err) {
    throw new LocalOpError(
      "image.writeFailed",
      `Failed to write mask at ${outPath}: ${(err as Error).message}`,
      { cause: err },
    );
  }
}
