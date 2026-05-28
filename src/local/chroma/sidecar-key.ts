import path from "node:path";
import { LocalOpError } from "../../errors.js";
import { readSidecar } from "../../sidecar/read.js";

/**
 * Read `request.chroma.color` from the per-image sidecar that sits next to
 * the input image. Lookup is direct: strip the image extension, append
 * `.json`. The generate/edit verbs write one sidecar per image (including
 * indexed `<stem>-NN.json` for n>1), so no filename-pattern mangling is
 * needed here.
 */
export async function loadKeyFromSidecar(inputPath: string): Promise<string> {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const stemFull = path.join(dir, stem);
  const sidecar = await readSidecar(stemFull);
  const req = sidecar.request as Record<string, unknown> | undefined;
  const chroma = req?.chroma as { color?: string } | undefined;
  if (!chroma || typeof chroma.color !== "string") {
    throw new LocalOpError(
      "image.formatUnknown",
      `Sidecar at ${stemFull}.json does not contain request.chroma.color`,
    );
  }
  return chroma.color;
}
