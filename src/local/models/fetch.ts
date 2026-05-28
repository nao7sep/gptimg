/**
 * Lazy model fetcher.
 *
 * Contract:
 *   - ensureModel(entry, cacheDir) returns the absolute path to the cached
 *     model file. If the file is already present, it is returned with no
 *     network call.
 *   - Otherwise the file is downloaded to `<final>.partial`, then atomically
 *     renamed to its final name. A partial file from an interrupted prior
 *     run is removed before the new download starts so the cache never
 *     contains a half-downloaded file under its final name.
 *   - One-line progress notes go to stderr; stdout stays clean for JSON
 *     output.
 *
 * No content hashing: version reproducibility is the URL's job — pin the
 * registry entry to a specific HuggingFace commit when locking a version.
 */

import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { LocalOpError, toAbortError } from "../../errors.js";
import type { ModelEntry } from "./registry.js";

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw toAbortError(signal.reason);
}

async function downloadTo(
  url: string,
  destPath: string,
  signal: AbortSignal | undefined,
): Promise<number> {
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (err) {
    if (signal?.aborted) throw toAbortError(signal.reason);
    throw new LocalOpError(
      "model.downloadFailed",
      `Failed to fetch ${url}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  if (!response.ok || !response.body) {
    throw new LocalOpError(
      "model.downloadFailed",
      `Failed to fetch ${url}: HTTP ${response.status}`,
    );
  }

  const total = Number(response.headers.get("content-length") ?? 0);
  let received = 0;
  let lastReported = 0;
  const stream = createWriteStream(destPath);

  process.stderr.write(`gptimg: downloading ${path.basename(destPath)}...\n`);

  try {
    const reader = response.body.getReader();
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      await new Promise<void>((resolve, reject) => {
        stream.write(value, (err) => (err ? reject(err) : resolve()));
      });
      if (total > 0) {
        const percent = Math.floor((received / total) * 100);
        if (percent >= lastReported + 10) {
          lastReported = percent;
          process.stderr.write(`gptimg: ${percent}% (${received}/${total} bytes)\n`);
        }
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      stream.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
    });
  }

  process.stderr.write(
    `gptimg: downloaded ${received} bytes to ${path.basename(destPath)}\n`,
  );

  return received;
}

export async function ensureModel(
  entry: ModelEntry,
  cacheDir: string,
  opts: { signal?: AbortSignal | undefined } = {},
): Promise<string> {
  const { signal } = opts;
  throwIfAborted(signal);

  await mkdir(cacheDir, { recursive: true });
  const finalPath = path.join(cacheDir, entry.name);

  if (existsSync(finalPath)) {
    return finalPath;
  }

  const partialPath = `${finalPath}.partial`;
  if (existsSync(partialPath)) {
    await unlink(partialPath);
  }

  try {
    await downloadTo(entry.url, partialPath, signal);
  } catch (err) {
    await unlink(partialPath).catch(() => undefined);
    throw err;
  }

  await rename(partialPath, finalPath);
  return finalPath;
}
