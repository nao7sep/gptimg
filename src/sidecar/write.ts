import { mkdir } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../internal/atomic-file.js";
import { LocalOpError } from "../errors.js";
import { SIDECAR_FORMAT_VERSION } from "../format-versions.js";
import type { Sidecar } from "../types.js";
import { refuseNewerSidecar, validSidecar } from "./read.js";

function sidecarPathForStem(stem: string): string {
  return `${stem}.json`;
}

/**
 * Write a sidecar to `<stem>.json`, stamped with its format version. A sidecar
 * not of the current shape is refused, and an existing sidecar in a newer
 * format is refused and left unchanged.
 *
 * @returns the absolute or relative sidecar path that was written.
 */
export async function writeSidecar(
  stem: string,
  sidecar: Sidecar,
  opts: { overwrite?: boolean } = {},
): Promise<string> {
  const sidecarPath = sidecarPathForStem(stem);
  const overwrite = opts.overwrite ?? true;
  validSidecar(sidecar, `Sidecar for ${sidecarPath} is invalid and was not written`);
  if (overwrite) refuseNewerSidecar(sidecarPath);
  try {
    await mkdir(path.dirname(sidecarPath), { recursive: true });
    const text = JSON.stringify({ ...sidecar, formatVersion: SIDECAR_FORMAT_VERSION }, null, 2) + "\n";
    await writeFileAtomic(sidecarPath, text, { encoding: "utf-8", overwrite });
  } catch (err) {
    if (!overwrite && (err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new LocalOpError(
        "output.exists",
        `Output exists: ${sidecarPath}. Set overwrite: true to allow.`,
        { cause: err },
      );
    }
    throw new LocalOpError(
      "sidecar.writeFailed",
      `Failed to write sidecar at ${sidecarPath}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  return sidecarPath;
}
