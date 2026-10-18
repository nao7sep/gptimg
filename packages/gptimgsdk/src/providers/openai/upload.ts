import { readFile } from "node:fs/promises";
import path from "node:path";
import { toFile } from "openai";
import { GptImgError, fsError } from "../../errors.ts";
import { detectFormat } from "../../image/detectFormat.ts";

const EDIT_UPLOAD_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export async function imageFileForEditUpload(
  filePath: string,
  label: string,
): Promise<Awaited<ReturnType<typeof toFile>>> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (err) {
    throw fsError(err, `Failed to read ${label} image`, filePath);
  }

  const fmt = await detectFormat(bytes);
  const mime = EDIT_UPLOAD_MIME[fmt.format] ?? EDIT_UPLOAD_MIME[fmt.extension];
  if (!mime) {
    throw new GptImgError("image.unsupportedFormat", `Unsupported ${label} image format for OpenAI edit upload: ${fmt.format}`, {
      subject: filePath,
    });
  }

  return toFile(bytes, path.basename(filePath), { type: mime });
}
