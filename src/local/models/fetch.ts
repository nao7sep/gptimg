/**
 * Lazy model fetcher.
 *
 * Contract:
 *   - ensureModel(entry, cacheDir) returns the absolute path to the cached
 *     model file. If the file is already present, it is returned with no
 *     network call.
 *   - Otherwise the file is downloaded to a per-process unique partial path
 *     (`<final>.partial.<pid>.<random>`) and then published to the final
 *     name via POSIX `link()`, which is atomic and fails with EEXIST if
 *     another concurrent caller published first. Concurrent callers waste
 *     bandwidth (each downloads to its own partial) but never corrupt the
 *     cache: only the winning `link()` becomes the final file, all losers
 *     unlink their partial and return the published path.
 *   - One-line progress notes go to stderr; stdout stays clean for JSON
 *     output.
 *
 * No content hashing: version reproducibility is the URL's job — pin the
 * registry entry to a specific HuggingFace commit when locking a version.
 */

import { createWriteStream, existsSync } from "node:fs";
import { link, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
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

function partialPathFor(finalPath: string): string {
  const suffix = randomBytes(6).toString("hex");
  return `${finalPath}.partial.${process.pid}.${suffix}`;
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

  // Legacy cleanup: pre-link()-rework versions used a fixed `<final>.partial`
  // name that older interrupted runs may have left behind. The unique-suffix
  // partials produced by the new code never collide with it, so removing
  // the legacy artifact is safe and frees disk on first post-upgrade run.
  const legacyPartial = `${finalPath}.partial`;
  if (existsSync(legacyPartial)) {
    await unlink(legacyPartial).catch(() => undefined);
  }

  // Each caller writes to its own partial path; no shared filename, so
  // concurrent downloads never interleave bytes on the same file.
  const partialPath = partialPathFor(finalPath);

  try {
    await downloadTo(entry.url, partialPath, signal);
  } catch (err) {
    await unlink(partialPath).catch(() => undefined);
    throw err;
  }

  // POSIX link() is atomic: it succeeds (final name now references our
  // partial inode) or fails with EEXIST (another caller already published).
  // Either way our partial is no longer needed under its temp name.
  try {
    await link(partialPath, finalPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      await unlink(partialPath).catch(() => undefined);
      throw new LocalOpError(
        "model.downloadFailed",
        `Failed to publish model at ${finalPath}: ${(err as Error).message}`,
        { cause: err },
      );
    }
    // Another concurrent caller won the publish race — drop our copy.
  }
  await unlink(partialPath).catch(() => undefined);

  return finalPath;
}
