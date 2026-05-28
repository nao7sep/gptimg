import path from "node:path";
import { LocalOpError } from "../../errors.js";
import { readSidecar } from "../../sidecar/read.js";

/**
 * Read `request.chroma.color` from the sibling sidecar of the given image.
 * Strips trailing `-NN` indexes so `donut-01.png` resolves to `donut.json`.
 */
export async function loadKeyFromSidecar(inputPath: string): Promise<string> {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath);
  const dot = base.lastIndexOf(".");
  const rawStem = dot > 0 ? base.slice(0, dot) : base;
  const stem = rawStem.replace(/-\d+$/, "");
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
