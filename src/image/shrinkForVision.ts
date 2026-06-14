import sharp from "sharp";
import { LocalOpError } from "../errors.js";

export interface ShrinkBox {
  width: number;
  height: number;
}

export interface ShrinkResult {
  buffer: Buffer;
  applied: boolean;
  originalWidth: number;
  originalHeight: number;
  outputWidth: number;
  outputHeight: number;
  format: string;
}

const DEFAULT_FIT: ShrinkBox = { width: 1024, height: 1024 };

export async function shrinkForVision(
  input: Buffer | Uint8Array | string,
  fit: ShrinkBox = DEFAULT_FIT,
): Promise<ShrinkResult> {
  try {
    const pipeline = sharp(input as Buffer);
    const meta = await pipeline.metadata();
    if (meta.width === undefined || meta.height === undefined) {
      // No readable dimensions means the bytes aren't a decodable raster; fail at
      // the boundary instead of carrying a degenerate 0x0 size into the result.
      throw new LocalOpError(
        "image.decodeFailed",
        "Failed to prepare image for vision: the image reports no width/height.",
      );
    }
    const ow = meta.width;
    const oh = meta.height;
    const fmt = meta.format ?? "png";

    const needsShrink = ow > fit.width || oh > fit.height;

    if (!needsShrink) {
      const buffer = await sharp(input as Buffer).toBuffer();
      return {
        buffer,
        applied: false,
        originalWidth: ow,
        originalHeight: oh,
        outputWidth: ow,
        outputHeight: oh,
        format: fmt,
      };
    }

    const resized = await sharp(input as Buffer)
      .resize({
        width: fit.width,
        height: fit.height,
        fit: "inside",
        withoutEnlargement: true,
      })
      .toBuffer({ resolveWithObject: true });

    return {
      buffer: resized.data,
      applied: true,
      originalWidth: ow,
      originalHeight: oh,
      outputWidth: resized.info.width,
      outputHeight: resized.info.height,
      format: resized.info.format,
    };
  } catch (err) {
    if (err instanceof LocalOpError) throw err;
    throw new LocalOpError(
      "image.decodeFailed",
      `Failed to prepare image for vision: ${(err as Error).message}`,
      { cause: err },
    );
  }
}
