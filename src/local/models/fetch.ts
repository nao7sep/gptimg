/**
 * Lazy model fetcher.
 *
 * Contract:
 *   - ensureModel(entry, cacheDir) returns the absolute path to the cached
 *     model file. If a pinned artifact is already present at its exact known
 *     size, it is returned with no network call.
 *   - The model URL must be https; a non-https remote URL is refused before any
 *     byte is fetched (http is allowed only for a loopback test server).
 *   - Otherwise the file is downloaded under the `modelDownload` network
 *     budget (per-edge idle timeout + bounded retries, inside one size-scaled
 *     operation deadline) into a deletable `temp/`
 *     dir under the cache root (a per-download-unique name), then published to
 *     the final name via `link()`, which is atomic and fails with EEXIST
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
 * Shipped models pin both an immutable source URL and a SHA-256. The staged
 * bytes are hashed before publish; cache hits are trusted until a caller asks
 * the public model API to verify them again.
 */

import { createReadStream, createWriteStream, statSync } from "node:fs";
import { link, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
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

export async function fileSha256(
  filePath: string,
  signal?: AbortSignal | undefined,
): Promise<string> {
  throwIfAborted(signal);
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  const abort = (): void => {
    stream.destroy(toAbortError(signal?.reason));
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of stream) {
      throwIfAborted(signal);
      hash.update(chunk);
    }
    throwIfAborted(signal);
    return hash.digest("hex");
  } catch (err) {
    if (signal?.aborted) throw toAbortError(signal.reason);
    throw err;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

function timeoutError(message: string): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

function errorFromSignal(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : toAbortError(signal.reason);
}

/** A resettable bound for DNS/connect/TLS/redirect/body-idle waits. */
function idleSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  reset: () => void;
  dispose: () => void;
} {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onParentAbort = (): void => controller.abort(parent?.reason);
  const reset = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(timeoutError(`Model network edge timed out after ${timeoutMs}ms.`)),
      timeoutMs,
    );
    timer.unref?.();
  };
  const dispose = (): void => {
    if (timer) clearTimeout(timer);
    parent?.removeEventListener("abort", onParentAbort);
  };

  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  reset();
  return { signal: controller.signal, reset, dispose };
}

function advertisedLength(headers: Headers): number | undefined {
  const raw = headers.get("content-length");
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new LocalOpError("model.invalidSize", `Invalid model Content-Length: ${raw}.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new LocalOpError("model.invalidSize", `Model Content-Length is not a safe integer: ${raw}.`);
  }
  return value;
}

async function syncFile(filePath: string, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  const handle = await open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  throwIfAborted(signal);
}

async function syncDirectory(dirPath: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(dirPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;

/**
 * One download attempt. Streams `url` to `destPath`; `timeoutMs` bounds each
 * DNS/connect/TLS/redirect/body-idle edge and the parent signal bounds the full
 * acquisition. Throws a status- or code-bearing error so the retry layer can
 * classify retryability.
 */
async function downloadAttempt(
  url: string,
  destPath: string,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  logger: Logger | undefined,
  name: string,
  expectedBytes: number | undefined,
  maxBytes: number,
): Promise<void> {
  const idle = idleSignal(parentSignal, timeoutMs);
  const signal = idle.signal;

  try {
    const initial = new URL(url);
    const allowLoopbackHttp = initial.protocol === "http:";
    let currentUrl = url;
    let response: Response | undefined;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      idle.reset();
      try {
        response = await fetch(currentUrl, { signal, redirect: "manual" });
      } catch (err) {
        if (parentSignal?.aborted) throw errorFromSignal(parentSignal);
        throw err;
      }
      if (!REDIRECT_STATUSES.has(response.status)) break;
      if (redirects === MAX_REDIRECTS) {
        throw new LocalOpError("model.redirectFailed", `Too many redirects downloading ${url}.`);
      }
      const location = response.headers.get("location");
      if (!location) {
        throw new LocalOpError(
          "model.redirectFailed",
          `Redirect downloading ${currentUrl} did not include a Location header.`,
        );
      }
      await response.body?.cancel();
      currentUrl = new URL(location, currentUrl).toString();
      assertSafeUrl(currentUrl, allowLoopbackHttp);
    }
    if (!response) throw new LocalOpError("model.downloadFailed", `No response downloading ${url}.`);
    if (!response.ok || !response.body) {
      throw new HttpStatusError(response.status, response.headers, "");
    }

    const total = advertisedLength(response.headers);
    if (total !== undefined && total > maxBytes) {
      await response.body.cancel();
      throw new LocalOpError(
        "model.sizeExceeded",
        `Refusing ${name}: advertised ${total} bytes exceeds the ${maxBytes}-byte limit.`,
      );
    }
    if (expectedBytes !== undefined && total !== undefined && total !== expectedBytes) {
      await response.body.cancel();
      throw new LocalOpError(
        "model.sizeMismatch",
        `Refusing ${name}: advertised ${total} bytes, expected exactly ${expectedBytes}.`,
      );
    }
    let received = 0;
    let lastReported = 0;
    const stream = createWriteStream(destPath);
    const abortWrite = (): void => {
      stream.destroy(errorFromSignal(signal));
    };
    signal.addEventListener("abort", abortWrite, { once: true });

    await logger?.info("download", `downloading ${name}`, { name });

    const reader = response.body.getReader();
    try {
      for (;;) {
        idle.reset();
        const { done, value } = await reader.read();
        if (done) break;
        const nextReceived = received + value.length;
        if (nextReceived > maxBytes) {
          throw new LocalOpError(
            "model.sizeExceeded",
            `Refusing ${name}: streamed bytes exceed the ${maxBytes}-byte limit.`,
          );
        }
        received = nextReceived;
        await new Promise<void>((resolve, reject) => {
          stream.write(value, (err) => (err ? reject(err) : resolve()));
        });
        if (total !== undefined && total > 0) {
          const percent = Math.floor((received / total) * 100);
          if (percent >= lastReported + 10) {
            lastReported = percent;
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
      await reader.cancel().catch(() => undefined);
      await finishWrite(stream).catch(() => undefined);
      signal.removeEventListener("abort", abortWrite);
      if (parentSignal?.aborted) throw errorFromSignal(parentSignal);
      throw err;
    }

    try {
      await finishWrite(stream);
    } finally {
      signal.removeEventListener("abort", abortWrite);
    }
    if (expectedBytes !== undefined && received !== expectedBytes) {
      throw new LocalOpError(
        "model.sizeMismatch",
        `Refusing ${name}: downloaded ${received} bytes, expected exactly ${expectedBytes}.`,
      );
    }
    await logger?.info("download", `downloaded ${name} (${received} bytes)`, {
      name,
      bytes: received,
    });
  } finally {
    idle.dispose();
  }
}

const TEMP_DIR = "temp";
const MAX_MODEL_BYTES = 1024 * 1024 * 1024;
const MIN_TRANSFER_BYTES_PER_SECOND = 32 * 1024;
const MODEL_OPERATION_OVERHEAD_MS = 15 * 60_000;
const MAX_TIMER_MS = 2_147_000_000;

export function modelWholeTimeoutMs(byteLimit: number, maxRetries: number): number {
  const attempts = Math.max(1, maxRetries + 1);
  return Math.min(
    MAX_TIMER_MS,
    MODEL_OPERATION_OVERHEAD_MS +
      Math.ceil((byteLimit * attempts * 1000) / MIN_TRANSFER_BYTES_PER_SECOND),
  );
}

export function inspectCachedModel(
  filePath: string,
  expectedBytes: number | undefined,
): { present: boolean; usable: boolean; sizeBytes?: number } {
  try {
    const stat = statSync(filePath);
    return {
      present: true,
      usable: stat.isFile() && (expectedBytes === undefined || stat.size === expectedBytes),
      sizeBytes: stat.size,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { present: false, usable: false };
    }
    throw err;
  }
}

// https-only: a non-https model URL is refused before any byte is fetched, per
// the managed-runtime-dependencies convention. http is permitted only for a
// loopback host (localhost / 127.0.0.1 / ::1), which carries no network-MITM
// surface and is how the local test server runs; every shipped registry URL is
// https.
function assertSafeUrl(url: string, allowLoopbackHttp = true): void {
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
  if (allowLoopbackHttp && parsed.protocol === "http:" && loopback) return;
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
  const suffix = nanoid();
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
  if (!Number.isSafeInteger(entry.byteSize) && entry.byteSize !== undefined) {
    throw new LocalOpError("model.invalidSize", `Invalid expected byte size for ${entry.name}.`);
  }
  if (entry.byteSize !== undefined && entry.byteSize <= 0) {
    throw new LocalOpError("model.invalidSize", `Invalid expected byte size for ${entry.name}.`);
  }
  if (!Number.isSafeInteger(budget.timeout) || budget.timeout <= 0 || budget.timeout > MAX_TIMER_MS) {
    throw new LocalOpError("model.invalidBudget", "Model network timeout must be positive.");
  }
  if (!Number.isSafeInteger(budget.maxRetries) || budget.maxRetries < 0) {
    throw new LocalOpError("model.invalidBudget", "Model maxRetries must be a non-negative integer.");
  }
  const byteLimit = entry.byteSize ?? MAX_MODEL_BYTES;
  const operationSignal = combineSignals(signal, modelWholeTimeoutMs(byteLimit, budget.maxRetries));
  throwIfAborted(operationSignal);
  assertSafeUrl(entry.url);

  await mkdir(cacheDir, { recursive: true });
  const finalPath = path.join(cacheDir, entry.name);

  const initialCache = inspectCachedModel(finalPath, entry.byteSize);
  if (!force && initialCache.usable) {
    return finalPath;
  }
  const replaceExisting = initialCache.present;

  await mkdir(path.join(cacheDir, TEMP_DIR), { recursive: true });
  let partialPath: string;
  try {
    partialPath = await callWithRetry(
      { budgetName: "modelDownload", budget, signal: operationSignal, logger },
      async () => {
        const p = stagingPathFor(cacheDir, entry.name);
        try {
          await downloadAttempt(
            entry.url,
            p,
            budget.timeout,
            operationSignal,
            logger,
            entry.name,
            entry.byteSize,
            byteLimit,
          );
        } catch (err) {
          await unlink(p).catch(() => undefined);
          throw err;
        }
        return p;
      },
    );
  } catch (err) {
    if (signal?.aborted) throw toAbortError(signal.reason);
    if (operationSignal.aborted) {
      throw new LocalOpError("model.timeout", `Timed out acquiring ${entry.name}.`, { cause: err });
    }
    if (isAbortError(err)) throw err;
    if (err instanceof LocalOpError) throw err;
    throw new LocalOpError(
      "model.downloadFailed",
      `Failed to download ${entry.url}: ${(err as Error).message}`,
      { cause: err },
    );
  }

  try {
    // Verify the pinned hash before publishing. A mismatch means the pinned URL
    // changed or the download is corrupt — fail loudly rather than cache bad
    // bytes. Non-retryable: a fully-downloaded-but-wrong file won't fix itself.
    if (entry.sha256) {
      const got = await fileSha256(partialPath, operationSignal);
      if (got !== entry.sha256) {
        throw new LocalOpError(
          "model.checksumMismatch",
          `Downloaded ${entry.name} has sha256 ${got}, expected ${entry.sha256}. ` +
            `The pinned URL may have changed or the download is corrupt.`,
        );
      }
    }

    await syncFile(partialPath, operationSignal);
    throwIfAborted(operationSignal);
    if (force || replaceExisting) {
      // Deliberate reinstall: atomically replace whatever is there.
      try {
        await rename(partialPath, finalPath);
      } catch (err) {
        throw new LocalOpError(
          "model.downloadFailed",
          `Failed to publish model at ${finalPath}: ${(err as Error).message}`,
          { cause: err },
        );
      }
      await syncDirectory(cacheDir);
      throwIfAborted(operationSignal);
      return finalPath;
    }

    // link() is atomic on supported filesystems: it succeeds (the final name
    // now references our staged file) or fails with EEXIST when another caller
    // published first. Either way the staged name is no longer needed.
    try {
      await link(partialPath, finalPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST" && !inspectCachedModel(finalPath, entry.byteSize).usable) {
        throwIfAborted(operationSignal);
        await rename(partialPath, finalPath);
      } else if (code !== "EEXIST") {
        throw new LocalOpError(
          "model.downloadFailed",
          `Failed to publish model at ${finalPath}: ${(err as Error).message}`,
          { cause: err },
        );
      }
      // Another concurrent caller won the publish race — drop our copy.
    }
    await syncDirectory(cacheDir);
    throwIfAborted(operationSignal);
  } catch (err) {
    await unlink(partialPath).catch(() => undefined);
    if (signal?.aborted) throw toAbortError(signal.reason);
    if (operationSignal.aborted) {
      throw new LocalOpError("model.timeout", `Timed out acquiring ${entry.name}.`, { cause: err });
    }
    if (err instanceof LocalOpError) throw err;
    throw new LocalOpError(
      "model.downloadFailed",
      `Failed to prepare ${entry.name} for publication: ${(err as Error).message}`,
      { cause: err },
    );
  }
  await unlink(partialPath).catch(() => undefined);

  return finalPath;
}
