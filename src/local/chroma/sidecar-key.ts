import { readFile } from "node:fs/promises";
import path from "node:path";
import { LocalOpError } from "../../errors.js";
import { hash } from "../../image/hash.js";
import { readSidecar } from "../../sidecar/read.js";
import type { Sidecar } from "../../types.js";

/**
 * Read `request.chroma.color` from the per-image sidecar that sits next to
 * the input image. Lookup is direct: strip the image extension, append
 * `.json`. The generate/edit verbs write one sidecar per image (including
 * indexed `<stem>-NN.json` for n>1), so no filename-pattern mangling is
 * needed here.
 *
 * With `verifyImage`, the sidecar must describe this image: one of its file
 * entries carries the input's SHA-256. A replaced image beside an earlier
 * run's sidecar (an overwrite interrupted between the two files, or a file
 * copied over) would otherwise key with the wrong color. Names are not
 * compared, so a pair renamed together still works.
 */
export async function loadKeyFromSidecar(
  inputPath: string,
  options: { verifyImage?: boolean } = {},
): Promise<string> {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const stemFull = path.join(dir, stem);
  const sidecar = await readSidecar(stemFull);
  if (options.verifyImage) await assertSidecarDescribesImage(sidecar, `${stemFull}.json`, inputPath);
  const req = sidecar.request as Record<string, unknown> | undefined;
  const chroma = req?.chroma as { color?: string } | undefined;
  if (!chroma || typeof chroma.color !== "string") {
    throw new LocalOpError(
      "sidecar.malformed",
      `Sidecar at ${stemFull}.json does not contain request.chroma.color`,
    );
  }
  return chroma.color;
}

async function assertSidecarDescribesImage(sidecar: Sidecar, sidecarPath: string, inputPath: string): Promise<void> {
  let image: Buffer;
  try {
    image = await readFile(inputPath);
  } catch (err) {
    throw new LocalOpError("image.readFailed", `Failed to read image at ${inputPath}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  const sha256 = hash(image);
  if (!sidecar.files.some((file) => file.sha256 === sha256)) {
    throw new LocalOpError(
      "sidecar.imageMismatch",
      `Sidecar at ${sidecarPath} does not describe ${inputPath}: no file entry has its SHA-256. ` +
        `The image was replaced after the sidecar was written; pass the key color explicitly.`,
    );
  }
}
