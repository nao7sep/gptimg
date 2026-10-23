import { mkdir } from "node:fs/promises";
import path from "node:path";
import { GptImgError, fsError } from "../errors.ts";
import { SIDECAR_FORMAT_VERSION } from "../format-versions.ts";
import { writeOutputBytes } from "../internal/output-files.ts";
import { formatZodError } from "../internal/zodError.ts";
import type { Sidecar } from "../types.ts";
import { refuseNewerSidecar } from "./read.ts";
import { SidecarV2Schema } from "./schema.ts";

/** The bytes of a current-format sidecar: fixed key order, two-space indent, trailing newline. */
export function serializeSidecar(sidecar: Sidecar): string {
  const { kind, writer, request, response, files } = sidecar;
  return JSON.stringify({ formatVersion: SIDECAR_FORMAT_VERSION, kind, writer, request, response, files }, null, 2) + "\n";
}

/**
 * Publish a current-format sidecar at the absolute `sidecarPath`, whole or not
 * at all. A record not of the current shape is an internal error (the SDK
 * built it), and an existing sidecar in a newer format is refused and left
 * unchanged.
 */
export async function writeSidecar(
  sidecarPath: string,
  sidecar: Sidecar,
  opts: { overwrite: boolean },
): Promise<void> {
  const text = serializeSidecar(sidecar);
  const check = SidecarV2Schema.safeParse(JSON.parse(text));
  if (!check.success) {
    throw new GptImgError("internal.invariant", `Sidecar for ${sidecarPath} would be invalid: ${formatZodError(check.error)}`, {
      subject: sidecarPath,
    });
  }
  if (opts.overwrite) await refuseNewerSidecar(sidecarPath);
  try {
    await mkdir(path.dirname(sidecarPath), { recursive: true });
  } catch (err) {
    throw fsError(err, "Failed to create the sidecar's folder", path.dirname(sidecarPath), "none");
  }
  await writeOutputBytes(sidecarPath, text, opts.overwrite, "Failed to write sidecar");
}
