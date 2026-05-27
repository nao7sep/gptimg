import { mkdir } from "node:fs/promises";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { LocalOpError } from "../errors.js";
import { redact } from "../profile/redact.js";
import type { Sidecar } from "../types.js";

/**
 * Write a sidecar to `<stem>.json`. The sidecar is redacted via the
 * single redactor before serialization; the apiKey value can never appear
 * in the file on disk.
 *
 * @returns the absolute or relative sidecar path that was written.
 */
export async function writeSidecar(stem: string, sidecar: Sidecar): Promise<string> {
  const sidecarPath = `${stem}.json`;
  try {
    await mkdir(path.dirname(sidecarPath), { recursive: true });
    const safe = redact(sidecar);
    const text = JSON.stringify(safe, null, 2) + "\n";
    await writeFileAtomic(sidecarPath, text, { encoding: "utf-8" });
  } catch (err) {
    throw new LocalOpError(
      "sidecar.writeFailed",
      `Failed to write sidecar at ${sidecarPath}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  return sidecarPath;
}
