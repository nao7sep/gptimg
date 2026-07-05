/**
 * Lazy model fetcher.
 *
 * Contract:
 *   - ensureModel(entry, cacheDir) returns the absolute path to the cached
 *     model file. If the file is already present, it is returned with no
 *     network call.
 *   - The model URL must be https; a non-https remote URL is refused before any
 *     byte is fetched (http is allowed only for a loopback test server).
 *   - Otherwise the file is downloaded under the `modelDownload` network
 *     budget (per-attempt timeout + bounded retries) into a deletable `temp/`
 *     dir under the cache root (a per-download-unique name), then published to
 *     the final name via POSIX `link()`, which is atomic and fails with EEXIST
 *     if another concurrent caller published first. Concurrent callers waste
 *     bandwidth (each downloads its own staged copy) but never corrupt the
 *     cache: only the winning `link()` becomes the final file, all losers unlink
 *     their staged copy and return the published path. Staging in temp/ (not as
 *     a sibling of the kept model) keeps a crashed download's partial out of the
 *     model dir, in a clearly-disposable area.
 *   - Each retry attempt downloads to a fresh staged file, so a half-written
 *     file from a failed attempt never poisons the next one.
 *   - Download progress is reported through the logger (and thus the caller's
 *     onProgress sink) — never written to a stream directly, so the SDK stays
 *     stream-silent.
 *
 * No content hashing: version reproducibility is the URL's job — pin the
 * registry entry to a specific HuggingFace commit when locking a version.
 */

import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { link, mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { LocalOpError, toAbortError } from "../../errors.js";
import type { Logger } from "../../log/index.js";
import { NETWORK_DEFAULTS, type NetworkBudget } from "../../network/defaults.js";
import { combineSignals, HttpStatusError } from "../../network/http.js";
import { callWithRetry, isAbortError } from "../../network/retry.js";
import type { ModelEntry } from "./registry.js";

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw toAbortError(signal.reason);
}

function finishWrite(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    stream.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
  });
}

export function fileSha256(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(filePath);
    s.on("error", reject);
    s.on("data", (chunk) => h.update(chunk));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

/**
 * One download attempt. Streams `url` to `destPath`, bounded by `timeoutMs`
 * (the whole attempt, via a combined abort signal). Throws a status- or
 * code-bearing error so the retry layer can classify retryability; a fired
 * timeout surfaces as a TimeoutError (retryable). A parent-signal abort is
 * surfaced as AbortError so it is never mistaken for a retryable failure.
 */
async function downloadAttempt(
  url: string,
  destPath: string,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  logger: Logger | undefined,
  name: string,
): Promise<void> {
  const signal = combineSignals(parentSignal, timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (err) {
    if (parentSignal?.aborted) throw toAbortError(parentSignal.reason);
    throw err;
  }
  if (!response.ok || !response.body) {
    throw new HttpStatusError(response.status, response.headers, "");
  }

  const total = Number(response.headers.get("content-length") ?? 0);
  let received = 0;
  let lastReported = 0;
  const stream = createWriteStream(destPath);

  await logger?.info("download", `downloading ${name}`, { name });

  try {
    const reader = response.body.getReader();
    for (;;) {
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
          // Progress ticks scale with download size — `debug`, so they are
          // forwarded to the live progress stream but never persisted to an
          // end-user's log file. The start/end lines below stay `info`.
          await logger?.debug("download", `${name} ${percent}% (${received}/${total} bytes)`, {
            name,
            percent,
            received,
            total,
          });
        }
      }
    }
  } catch (err) {
    await finishWrite(stream).catch(() => undefined);
    if (parentSignal?.aborted) throw toAbortError(parentSignal.reason);
    throw err;
  }

  await finishWrite(stream);
  await logger?.info("download", `downloaded ${name} (${received} bytes)`, {
    name,
    bytes: received,
  });
}

const TEMP_DIR = "temp";

// https-only: a non-https model URL is refused before any byte is fetched, per
// the managed-runtime-dependencies convention. http is permitted only for a
// loopback host (localhost / 127.0.0.1 / ::1), which carries no network-MITM
// surface and is how the local test server runs; every shipped registry URL is
// https.
function assertSafeUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new LocalOpError("model.insecureUrl", `Invalid model URL: ${url}`);
  }
  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1" ||
    parsed.hostname === "[::1]";
  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:" && loopback) return;
  throw new LocalOpError(
    "model.insecureUrl",
    `Refusing insecure model URL (${parsed.protocol}//${parsed.hostname}); only https is allowed.`,
  );
}

// A per-download staging path inside the deletable temp/ dir under the cache
// root — same filesystem as the final path, so publish by link()/rename() stays
// atomic, and a leftover temp file lands in temp/, not beside the kept models.
// Named `<stem>-<pid>-<random>.tmp` per the derived-filename grammar: the
// model's own stem (so a leftover is traceable to its target), hyphen-joined
// to the pid+random discriminator that keeps concurrent downloads of the same
// model from colliding, and one `.tmp` extension for the file's current role.
export function stagingPathFor(cacheDir: string, name: string): string {
  const stem = path.parse(name).name;
  const suffix = randomBytes(6).toString("hex");
  return path.join(cacheDir, TEMP_DIR, `${stem}-${process.pid}-${suffix}.tmp`);
}

export async function ensureModel(
  entry: ModelEntry,
  cacheDir: string,
  opts: {
    signal?: AbortSignal | undefined;
    budget?: NetworkBudget;
    logger?: Logger;
    /** Re-download and replace even if the file is already cached. */
    force?: boolean;
  } = {},
): Promise<string> {
  const { signal, logger } = opts;
  const force = opts.force ?? false;
  const budget = opts.budget ?? NETWORK_DEFAULTS.modelDownload;
  throwIfAborted(signal);
  assertSafeUrl(entry.url);

  await mkdir(cacheDir, { recursive: true });
  const finalPath = path.join(cacheDir, entry.name);

  if (!force && existsSync(finalPath)) {
    return finalPath;
  }

  await mkdir(path.join(cacheDir, TEMP_DIR), { recursive: true });
  let partialPath: string;
  try {
    partialPath = await callWithRetry(
      { budgetName: "modelDownload", budget, signal, logger },
      async () => {
        const p = stagingPathFor(cacheDir, entry.name);
        try {
          await downloadAttempt(entry.url, p, budget.timeout, signal, logger, entry.name);
        } catch (err) {
          await unlink(p).catch(() => undefined);
          throw err;
        }
        return p;
      },
    );
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new LocalOpError(
      "model.downloadFailed",
      `Failed to download ${entry.url}: ${(err as Error).message}`,
      { cause: err },
    );
  }

  // Verify the pinned hash before publishing. A mismatch means the pinned URL
  // changed or the download is corrupt — fail loudly rather than cache bad
  // bytes. Non-retryable: a fully-downloaded-but-wrong file won't fix itself.
  if (entry.sha256) {
    const got = await fileSha256(partialPath);
    if (got !== entry.sha256) {
      await unlink(partialPath).catch(() => undefined);
      throw new LocalOpError(
        "model.checksumMismatch",
        `Downloaded ${entry.name} has sha256 ${got}, expected ${entry.sha256}. ` +
          `The pinned URL may have changed or the download is corrupt.`,
      );
    }
  }

  if (force) {
    // Deliberate reinstall: atomically replace whatever is there.
    await rename(partialPath, finalPath);
    return finalPath;
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
