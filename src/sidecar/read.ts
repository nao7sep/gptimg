import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { LocalOpError, type GptImgError } from "../errors.js";
import { SIDECAR_FORMAT_VERSION } from "../format-versions.js";
import { takeFormatVersion } from "../internal/format-version.js";
import type { Sidecar } from "../types.js";

export async function readSidecar(stem: string): Promise<Sidecar> {
  const sidecarPath = `${stem}.json`;
  let text: string;
  try {
    text = await readFile(sidecarPath, "utf-8");
  } catch (err) {
    throw new LocalOpError(
      "image.decodeFailed",
      `Failed to read sidecar at ${sidecarPath}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new LocalOpError(
      "image.decodeFailed",
      `Invalid JSON in sidecar at ${sidecarPath}`,
      { cause: err },
    );
  }
  return takeFormatVersion(parsed, SIDECAR_FORMAT_VERSION, {
    name: "sidecar",
    path: sidecarPath,
    ErrorClass: LocalOpError,
    invalidCode: "image.decodeFailed",
  }) as Sidecar;
}

/**
 * Refuse to replace an existing sidecar written in a newer format, so this
 * build never overwrites or removes metadata it cannot read
 * (store-recovery-conventions). An absent or unreadable file is left to the
 * caller's own overwrite decision.
 */
export function refuseNewerSidecar(sidecarPath: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(sidecarPath, "utf-8"));
  } catch {
    return;
  }
  try {
    takeFormatVersion(parsed, SIDECAR_FORMAT_VERSION, {
      name: "sidecar",
      path: sidecarPath,
      ErrorClass: LocalOpError,
      invalidCode: "image.decodeFailed",
    });
  } catch (err) {
    if ((err as GptImgError).code === "sidecar.newerFormat") throw err;
  }
}
