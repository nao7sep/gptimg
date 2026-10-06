import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { LocalOpError, type GptImgError } from "../errors.js";
import { SIDECAR_FORMAT_VERSION } from "../format-versions.js";
import { takeFormatVersion } from "../internal/format-version.js";
import { formatZodError } from "../internal/zodError.js";
import type { Sidecar } from "../types.js";
import { SidecarSchema } from "./schema.js";

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
  const body = takeFormatVersion(parsed, SIDECAR_FORMAT_VERSION, {
    name: "sidecar",
    path: sidecarPath,
    ErrorClass: LocalOpError,
    invalidCode: "image.decodeFailed",
  });
  return validSidecar(body, `Sidecar at ${sidecarPath} is invalid and was left unchanged`);
}

/** `value` as a sidecar of the current shape, or `sidecar.malformed` prefixed by `failure`. */
export function validSidecar(value: unknown, failure: string): Sidecar {
  const result = SidecarSchema.safeParse(value);
  if (!result.success) {
    throw new LocalOpError("sidecar.malformed", `${failure}: ${formatZodError(result.error)}`);
  }
  return result.data as Sidecar;
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
