import { readFile } from "node:fs/promises";
import path from "node:path";
import { toFile } from "openai";
import { GptImgError, fsError, processingError } from "../../errors.ts";
import { detectFormat } from "../../image/detectFormat.ts";
import { hash } from "../../image/hash.ts";

const EDIT_UPLOAD_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export async function imageFileForEditUpload(
  filePath: string,
  label: string,
): Promise<{ file: Awaited<ReturnType<typeof toFile>>; sha256: string }> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (err) {
    throw fsError(err, `Failed to read ${label} image`, filePath);
  }

  try {
    const fmt = await detectFormat(bytes);
    const mime = EDIT_UPLOAD_MIME[fmt.format] ?? EDIT_UPLOAD_MIME[fmt.extension];
    if (!mime) {
      throw new GptImgError("image.unsupportedFormat", `Unsupported ${label} image format for OpenAI edit upload: ${fmt.format}`, {
        subject: filePath,
      });
    }

    // File owns immutable bytes: provenance and every retry use this same snapshot.
    return { file: await toFile(bytes, path.basename(filePath), { type: mime }), sha256: hash(bytes) };
  } catch (err) {
    throw processingError(err, "Failed to prepare edit input image", filePath, "none");
  }
}
