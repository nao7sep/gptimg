import { readFile } from "node:fs/promises";
import { LocalOpError } from "../errors.js";
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
  try {
    return JSON.parse(text) as Sidecar;
  } catch (err) {
    throw new LocalOpError(
      "image.decodeFailed",
      `Invalid JSON in sidecar at ${sidecarPath}`,
      { cause: err },
    );
  }
}
