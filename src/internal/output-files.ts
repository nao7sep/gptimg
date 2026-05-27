import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { Buffer } from "node:buffer";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
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

export function assertOutputPathsAvailable(
  filePaths: string[],
  allowOverwrite: boolean,
): void {
  const seen = new Map<string, string>();
  for (const filePath of filePaths) {
    const resolved = path.resolve(filePath);
    const existing = seen.get(resolved);
    if (existing) {
      throw new LocalOpError(
        "output.duplicate",
        `Multiple outputs resolve to the same path: ${existing} and ${filePath}`,
      );
    }
    seen.set(resolved, filePath);
  }

  if (allowOverwrite) return;
  for (const filePath of filePaths) {
    if (existsSync(filePath)) {
      throw new LocalOpError(
        "output.exists",
        `Output exists: ${filePath}. Use overwrite to allow.`,
      );
    }
  }
}
