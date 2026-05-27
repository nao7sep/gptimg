import { readFile } from "node:fs/promises";
import path from "node:path";
import { toFile } from "openai";
import { LocalOpError } from "../../errors.js";
import { detectFormat } from "../../image/detectFormat.js";

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
    throw new LocalOpError(
      "image.readFailed",
      `Failed to read ${label} image at ${filePath}: ${(err as Error).message}`,
      { cause: err },
    );
  }

  const fmt = await detectFormat(bytes);
  const mime = EDIT_UPLOAD_MIME[fmt.format] ?? EDIT_UPLOAD_MIME[fmt.extension];
  if (!mime) {
    throw new LocalOpError(
      "image.formatUnknown",
      `Unsupported ${label} image format for OpenAI edit upload: ${fmt.format}`,
    );
  }

  return toFile(bytes, path.basename(filePath), { type: mime });
}
