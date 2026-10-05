import { readFile } from "node:fs/promises";
import { LocalOpError } from "../errors.js";
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
  }) as Sidecar;
}
