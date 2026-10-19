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
 *     model dir, in a clearly-disposable area, and the next ensureModel
 *     removes any staged file whose owning process is gone.
 *   - Each retry attempt downloads to a fresh staged file, so a half-written
 *     file from a failed attempt never poisons the next one.
 *   - Once the current file is on disk, files of the model's earlier pins
 *     (`entry.supersedes`) are deleted from the cache root, so a pin change
 *     does not leave the replaced model behind.
 *   - Download progress is reported through the logger (and thus the caller's
 *     onProgress sink) — never written to a stream directly, so the SDK stays
 *     stream-silent.
 *
 * Shipped models pin both an immutable source URL and a SHA-256. The staged
 * bytes are hashed before publish; cache hits are trusted until a caller asks
 * the public model API to verify them again.
 */

import { createReadStream, createWriteStream, statSync } from "node:fs";
import { link, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { finished } from "node:stream/promises";
import { nanoid } from "nanoid";
import { GptImgError, cancelledError, fsError, throwIfAborted } from "../../errors.ts";
import type { Logger } from "../../events/index.ts";
import { NETWORK_DEFAULTS, type NetworkBudget } from "../../network/defaults.ts";
import { combineSignals, HttpStatusError } from "../../network/http.ts";
import { callWithRetry, isAbortError } from "../../network/retry.ts";
import { MODELS, type ModelEntry } from "./registry.ts";

export async function fileSha256(
  filePath: string,
  signal?: AbortSignal | undefined,
  onBytes?: (done: number) => void,
): Promise<string> {
  throwIfAborted(signal);
  const hash = createHash("sha256");
  let done = 0;
  const stream = createReadStream(filePath);
  const abort = (): void => {
    stream.destroy(cancelledError(signal?.reason));
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of stream) {
      throwIfAborted(signal);
      hash.update(chunk);
      done += (chunk as Buffer).length;
      onBytes?.(done);
    }
    throwIfAborted(signal);
    return hash.digest("hex");
  } catch (err) {
    if (signal?.aborted) throw cancelledError(signal.reason);
    throw fsError(err, "Failed to hash", filePath);
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
  return signal.reason instanceof Error ? signal.reason : cancelledError(signal.reason);
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
    throw new GptImgError("model.integrity", `Invalid model Content-Length: ${raw}.`, { details: { actual: raw } });
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new GptImgError("model.integrity", `Model Content-Length is not a safe integer: ${raw}.`, { details: { actual: raw } });
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
        throw new GptImgError("model.badRedirect", `Too many redirects downloading ${url}.`, { subject: url });
      }
      const location = response.headers.get("location");
      if (!location) {
        throw new GptImgError("model.badRedirect", `Redirect downloading ${currentUrl} did not include a Location header.`, {
          subject: currentUrl,
        });
      }
      await response.body?.cancel();
      currentUrl = new URL(location, currentUrl).toString();
      assertSafeUrl(currentUrl, allowLoopbackHttp);
    }
    if (!response) throw new GptImgError("internal.invariant", `No response downloading ${url}.`, { subject: url });
    if (!response.ok || !response.body) {
      // Keep the server's complete error body (text-cleanup-conventions, rule
      // 4); a body that cannot be read still leaves the status to classify.
      const body = response.ok ? "" : await response.text().catch(() => "");
      if (parentSignal?.aborted) throw errorFromSignal(parentSignal);
      throw new HttpStatusError(response.status, response.headers, body);
    }

    const total = advertisedLength(response.headers);
    if (total !== undefined && total > maxBytes) {
      await response.body.cancel();
      throw new GptImgError("model.integrity", `Refusing ${name}: advertised ${total} bytes exceeds the ${maxBytes}-byte limit.`, {
        details: { expected: maxBytes, actual: total },
      });
    }
    if (expectedBytes !== undefined && total !== undefined && total !== expectedBytes) {
      await response.body.cancel();
      throw new GptImgError("model.integrity", `Refusing ${name}: advertised ${total} bytes, expected exactly ${expectedBytes}.`, {
        details: { expected: expectedBytes, actual: total },
      });
    }
    let received = 0;
    const stream = createWriteStream(destPath);
    // Observe the stream from creation so an abort or filesystem failure can
    // never emit an unhandled `error` event between the failing write and the
    // download loop's cleanup path. The rejection is still awaited below and
    // therefore remains part of the operation result.
    const writeFinished = finished(stream);
    void writeFinished.catch(() => undefined);
    const abortWrite = (): void => {
      stream.destroy(errorFromSignal(signal));
    };
    signal.addEventListener("abort", abortWrite, { once: true });

    logger?.emit("info", "download", { event: "model.download.start", name });

    const reader = response.body.getReader();
    try {
      for (;;) {
        idle.reset();
        const { done, value } = await reader.read();
        if (done) break;
        const nextReceived = received + value.length;
        if (nextReceived > maxBytes) {
          throw new GptImgError("model.integrity", `Refusing ${name}: streamed bytes exceed the ${maxBytes}-byte limit.`, {
            details: { expected: maxBytes, actual: nextReceived },
          });
        }
        received = nextReceived;
        await new Promise<void>((resolve, reject) => {
          stream.write(value, (err) => (err ? reject(err) : resolve()));
        });
        const expectedTotal = total ?? expectedBytes;
        if (expectedTotal !== undefined && expectedTotal > 0) logger?.progress("download", received, expectedTotal, "bytes", name);
      }
    } catch (err) {
      await reader.cancel().catch(() => undefined);
      if (!stream.destroyed) stream.destroy();
      await writeFinished.catch(() => undefined);
      signal.removeEventListener("abort", abortWrite);
      if (parentSignal?.aborted) throw errorFromSignal(parentSignal);
      throw err;
    }

    try {
      stream.end();
      await writeFinished;
    } finally {
      signal.removeEventListener("abort", abortWrite);
    }
    if (expectedBytes !== undefined && received !== expectedBytes) {
      throw new GptImgError("model.integrity", `Refusing ${name}: downloaded ${received} bytes, expected exactly ${expectedBytes}.`, {
        details: { expected: expectedBytes, actual: received },
      });
    }
    logger?.emit("info", "download", { event: "model.download.done", name, bytes: received });
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

/**
 * The path of `entry` in `modelsDir` when it is installed, or `model.notInstalled`
 * naming the install call. Nothing installs implicitly (sdk-conventions): a
 * 490 MB download never starts inside a masking or upscaling call.
 */
export function requireInstalledModel(entry: ModelEntry, key: string, modelsDir: string): string {
  const filePath = path.join(modelsDir, entry.name);
  const cache = inspectCachedModel(filePath, entry.byteSize);
  if (cache.usable) return filePath;
  throw new GptImgError(
    "model.notInstalled",
    `The ${key} model is not installed in ${modelsDir}${cache.present ? " (the file there is incomplete)" : ""}. ` +
      `Install it with img.model.install({ key: "${key}" }) first.`,
    { subject: filePath },
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
    throw fsError(err, "Failed to inspect the model file", filePath);
  }
}

// https-only: a non-https model URL is refused before any byte is fetched, per
// the managed-runtime-dependencies-conventions. http is permitted only for a
// loopback host (localhost / 127.0.0.1 / ::1), which carries no network-MITM
// surface and is how the local test server runs; every shipped registry URL is
// https.
function assertSafeUrl(url: string, allowLoopbackHttp = true): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GptImgError("model.insecureUrl", `Invalid model URL: ${url}`, { subject: url });
  }
  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1" ||
    parsed.hostname === "[::1]";
  if (parsed.protocol === "https:") return;
  if (allowLoopbackHttp && parsed.protocol === "http:" && loopback) return;
  throw new GptImgError("model.insecureUrl", `Refusing insecure model URL (${parsed.protocol}//${parsed.hostname}); only https is allowed.`, {
    subject: url,
  });
}

// A short, filename-safe tag identifying this host, so a staged file's owner
// can be told apart from a same-pid process on another machine. `modelsDir` can
// put the models on shared storage (a NAS, a container bind mount), where two hosts' pid spaces overlap: pid 4021 dead on
// host A says nothing about whether host B's pid 4021 is still downloading.
// Hashed rather than embedding the raw hostname, which can contain characters
// outside the staged-name grammar (spaces, dots, unicode) and would otherwise
// need its own escaping.
export function hostTag(): string {
  return createHash("sha256").update(hostname()).digest("hex").slice(0, 8);
}

// A per-download staging path inside the deletable temp/ dir under the cache
// root — same filesystem as the final path, so publish by link()/rename() stays
// atomic, and a leftover temp file lands in temp/, not beside the kept models.
// Named `<stem>-<hostTag>-<pid>-<random>.tmp` per the derived-filename grammar:
// the model's own stem (so a leftover is traceable to its target), hyphen-joined
// to the host tag (so ownership is scoped to the machine that started the
// download), the pid, and the random discriminator that keeps concurrent
// downloads of the same model on the same host from colliding, and one `.tmp`
// extension for the file's current role.
export function stagingPathFor(cacheDir: string, name: string): string {
  const stem = path.parse(name).name;
  const suffix = nanoid();
  return path.join(cacheDir, TEMP_DIR, `${stem}-${hostTag()}-${process.pid}-${suffix}.tmp`);
}

const STAGED_NAME = /-([0-9a-f]{8})-(\d+)-[A-Za-z0-9_-]{21}\.tmp$/;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove staged downloads whose process is gone on *this* host. A download
 * interrupted by Ctrl-C or a crash never reaches its own cleanup, and each one
 * can leave hundreds of MB in temp/. The owning host tag and pid are in every
 * staged name; a file tagged for another host is left alone regardless of
 * whether its pid happens to be alive here — pid liveness is only meaningful
 * within the host that reported it, and `modelsDir` can point several hosts at
 * the same shared directory. Among this host's own files, one whose
 * pid no longer runs is abandoned; files of live processes (this one included)
 * are in flight and stay. Best effort: a file another sweeper removed first,
 * or one that cannot be removed, is skipped.
 */
export async function sweepAbandonedStaging(cacheDir: string): Promise<void> {
  const tempDir = path.join(cacheDir, TEMP_DIR);
  let names: string[];
  try {
    names = await readdir(tempDir);
  } catch {
    return;
  }
  const thisHostTag = hostTag();
  for (const name of names) {
    const match = STAGED_NAME.exec(name);
    if (!match) continue;
    const [, taggedHost, pidText] = match;
    if (taggedHost !== thisHostTag) continue;
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || processIsAlive(pid)) continue;
    await unlink(path.join(tempDir, name)).catch(() => undefined);
  }
}

/**
 * A failed model download as the error naming its cause: the server's status,
 * a timeout, a lost connection, or the filesystem failing under the staged
 * file. A model download changes nothing remote, so no effect is unknown.
 */
function classifyDownloadFailure(err: unknown, url: string, finalPath: string): GptImgError {
  if (err instanceof GptImgError) return err;
  if (isAbortError(err)) return cancelledError(err);
  if (err instanceof HttpStatusError) {
    return new GptImgError("model.httpStatus", `Failed to download ${url}: ${err.message}`, {
      cause: err,
      subject: url,
      details: { status: err.status },
    });
  }
  const name = (err as { name?: unknown } | null)?.name;
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (name === "TimeoutError" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return new GptImgError("model.timeout", `Timed out downloading ${url}: ${(err as Error).message}`, { cause: err, subject: url });
  }
  if (typeof code === "string" && /^E[A-Z]+$/.test(code) && !/^E(CONN|NOTFOUND|AI_AGAIN|PIPE|HOSTUNREACH|NETUNREACH)/.test(code)) {
    return fsError(err, "Failed to stage a model download for", finalPath);
  }
  return new GptImgError("model.connectionLost", `Failed to download ${url}: ${(err as Error)?.message ?? String(err)}`, {
    cause: err,
    subject: url,
  });
}

interface EnsureModelOptions {
  signal?: AbortSignal | undefined;
  budget?: NetworkBudget;
  logger?: Logger;
  /** Re-download and replace even if the file is already cached. */
  force?: boolean;
}

export async function ensureModel(
  entry: ModelEntry,
  cacheDir: string,
  opts: EnsureModelOptions = {},
): Promise<string> {
  const finalPath = await acquireModel(entry, cacheDir, opts);
  await retireSupersededModels(entry, cacheDir, opts.logger);
  return finalPath;
}

/**
 * Delete the files of `entry`'s earlier pins (data-lifecycle-conventions:
 * derived data is deleted when replaced). Runs only after the current file is
 * published or found usable, so the replacement is verified first. A session
 * this process loaded can only hold a current pin, since pins are compiled in;
 * another process still running an older GptImg keeps its open file on POSIX,
 * while Windows refuses to delete a file another process holds without delete
 * sharing (a model ONNX Runtime has mapped), which is skipped and retried
 * on the next acquisition. Best effort: a refused deletion never fails the call
 * that needed the current model. A plain name is required so a registry entry
 * can never reach outside the cache root, and a name any current pin uses is
 * never deleted.
 */
async function retireSupersededModels(
  entry: ModelEntry,
  cacheDir: string,
  logger: Logger | undefined,
): Promise<void> {
  const currentNames = new Set([entry.name, ...Object.values(MODELS).map((model) => model.name)]);
  for (const name of entry.supersedes ?? []) {
    if (currentNames.has(name) || path.basename(name) !== name || name === "." || name === "..") continue;
    const filePath = path.join(cacheDir, name);
    try {
      await unlink(filePath);
      logger?.emit("info", "download", { event: "model.superseded.deleted", name, replacement: entry.name });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      logger?.emit("warn", "download", { event: "model.superseded.kept", name, replacement: entry.name, error: (err as Error).message });
    }
  }
}

async function acquireModel(
  entry: ModelEntry,
  cacheDir: string,
  opts: EnsureModelOptions,
): Promise<string> {
  const { signal, logger } = opts;
  const force = opts.force ?? false;
  const budget = opts.budget ?? NETWORK_DEFAULTS.modelDownload;
  const byteLimit = entry.byteSize ?? MAX_MODEL_BYTES;
  const operationSignal = combineSignals(signal, modelWholeTimeoutMs(byteLimit, budget.maxRetries));
  throwIfAborted(operationSignal);
  assertSafeUrl(entry.url);

  await mkdir(cacheDir, { recursive: true });
  await sweepAbandonedStaging(cacheDir);
  const finalPath = path.join(cacheDir, entry.name);

  const initialCache = inspectCachedModel(finalPath, entry.byteSize);
  if (!force && initialCache.usable) {
    return finalPath;
  }
  const replaceExisting = initialCache.present;
  // Announce the one-time download and its size before any request, so a
  // caller watching progress learns why the first AI mask or upscale waits.
  logger?.emit("info", "download", { event: "model.download.needed", name: entry.name });

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
    if (signal?.aborted) throw cancelledError(signal.reason);
    if (operationSignal.aborted) {
      throw new GptImgError("model.timeout", `Timed out acquiring ${entry.name}.`, { cause: err, subject: entry.url });
    }
    throw classifyDownloadFailure(err, entry.url, finalPath);
  }

  let namespacePublished = false;
  try {
    // Verify the pinned hash before publishing. A mismatch means the pinned URL
    // changed or the download is corrupt — fail loudly rather than cache bad
    // bytes. Non-retryable: a fully-downloaded-but-wrong file won't fix itself.
    if (entry.sha256) {
      const size = entry.byteSize;
      const got = await fileSha256(partialPath, operationSignal, (done) =>
        logger?.progress("hash", done, size ?? done, "bytes", entry.name),
      );
      if (got !== entry.sha256) {
        throw new GptImgError(
          "model.integrity",
          `Downloaded ${entry.name} has sha256 ${got}, expected ${entry.sha256}. ` +
            `The pinned URL may have changed or the download is corrupt.`,
          { subject: entry.url, details: { expected: entry.sha256, actual: got } },
        );
      }
    }

    await syncFile(partialPath, operationSignal);
    throwIfAborted(operationSignal);
    if (force || replaceExisting) {
      // Deliberate reinstall: atomically replace whatever is there.
      try {
        await rename(partialPath, finalPath);
        namespacePublished = true;
      } catch (err) {
        throw fsError(err, "Failed to publish model at", finalPath);
      }
      await syncDirectory(cacheDir);
      return finalPath;
    }

    // link() is atomic on supported filesystems: it succeeds (the final name
    // now references our staged file) or fails with EEXIST when another caller
    // published first. Either way the staged name is no longer needed.
    try {
      await link(partialPath, finalPath);
      namespacePublished = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST" && !inspectCachedModel(finalPath, entry.byteSize).usable) {
        throwIfAborted(operationSignal);
        await rename(partialPath, finalPath);
        namespacePublished = true;
      } else if (code !== "EEXIST") {
        throw fsError(err, "Failed to publish model at", finalPath);
      }
      // Another concurrent caller won the publish race — drop our copy.
    }
    await syncDirectory(cacheDir);
  } catch (err) {
    await unlink(partialPath).catch(() => undefined);
    // A successful rename/link is the cancellation commit point. A later
    // directory-sync error remains an error, but cancellation cannot relabel
    // an artifact that was already published as cancelled or timed out.
    if (namespacePublished) {
      if (err instanceof GptImgError) throw err;
      throw fsError(err, `Published ${entry.name}, but failed to sync`, cacheDir);
    }
    if (signal?.aborted) throw cancelledError(signal.reason);
    if (operationSignal.aborted) {
      throw new GptImgError("model.timeout", `Timed out acquiring ${entry.name}.`, { cause: err, subject: entry.url });
    }
    if (err instanceof GptImgError) throw err;
    throw fsError(err, `Failed to prepare ${entry.name} for publication at`, finalPath);
  }
  await unlink(partialPath).catch(() => undefined);

  return finalPath;
}
