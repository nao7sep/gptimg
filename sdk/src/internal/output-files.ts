import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Buffer } from "node:buffer";
import { fsError } from "../errors.ts";
import { refuse } from "../refusal.ts";
import { syncDirectory, writeFileAtomic } from "./atomic-file.ts";

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
  data: Buffer | Uint8Array | string,
  overwrite: boolean,
  failure = "Failed to write output",
): Promise<void> {
  try {
    await writeFileAtomic(filePath, typeof data === "string" ? data : Buffer.from(data), { overwrite });
  } catch (err) {
    if (!overwrite && (err as NodeJS.ErrnoException).code === "EEXIST") {
      refuse("output.exists", `Output exists: ${filePath}. Set overwrite: true to allow.`, { subject: filePath });
    }
    throw fsError(err, failure, filePath, "unknown");
  }
}

/**
 * `writeOutputBytes` for a paid provider image or its sidecar, the only
 * evidence of a charged request: the folder is flushed too, so a crash cannot
 * leave the name pointing at nothing (rejected-mechanisms-conventions,
 * Power-loss durability machinery, keeps this one flush). A failure to flush
 * is thrown with effect `unknown`, the file already published.
 */
export async function writeProviderOutput(
  filePath: string,
  data: Buffer | Uint8Array | string,
  overwrite: boolean,
  failure = "Failed to write output",
): Promise<void> {
  await writeOutputBytes(filePath, data, overwrite, failure);
  try {
    await syncDirectory(path.dirname(filePath));
  } catch (err) {
    throw fsError(err, failure, filePath, "unknown");
  }
}
