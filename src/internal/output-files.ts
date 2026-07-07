import { mkdir } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { writeFileAtomic } from "./atomic-file.js";
import { LocalOpError } from "../errors.js";

export async function ensureOutputDir(outDir: string): Promise<void> {
  try {
    await mkdir(outDir, { recursive: true });
  } catch (err) {
    throw new LocalOpError(
      "output.mkdirFailed",
      `Failed to create output directory ${outDir}: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

export async function writeOutputBytes(
  filePath: string,
  data: Buffer | Uint8Array,
): Promise<void> {
  try {
    await writeFileAtomic(filePath, Buffer.from(data));
  } catch (err) {
    throw new LocalOpError(
      "output.writeFailed",
      `Failed to write output at ${filePath}: ${(err as Error).message}`,
      { cause: err },
    );
  }
}
