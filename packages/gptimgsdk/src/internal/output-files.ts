import { mkdir } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { fsError } from "../errors.ts";
import { refuse } from "../refusal.ts";
import { writeFileAtomic } from "./atomic-file.ts";

export async function ensureOutputDir(outDir: string): Promise<void> {
  try {
    await mkdir(outDir, { recursive: true });
  } catch (err) {
    throw fsError(err, "Failed to create output directory", outDir);
  }
}

/**
 * Publish `data` at `filePath` whole or not at all. A destination that appeared
 * since the availability check is refused when the call did not ask to
 * overwrite; any other failure is the filesystem's cause, with effect
 * `unknown` because the write had begun.
 */
export async function writeOutputBytes(
  filePath: string,
  data: Buffer | Uint8Array,
  overwrite: boolean,
): Promise<void> {
  try {
    await writeFileAtomic(filePath, Buffer.from(data), { overwrite });
  } catch (err) {
    if (!overwrite && (err as NodeJS.ErrnoException).code === "EEXIST") {
      refuse("output.exists", `Output exists: ${filePath}. Set overwrite: true to allow.`, { subject: filePath });
    }
    throw fsError(err, "Failed to write output", filePath, "unknown");
  }
}
