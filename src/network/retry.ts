import type { Logger } from "../log/index.js";
import { toAbortError } from "../errors.js";
import type { NetworkBudget, NetworkBudgetName } from "./defaults.js";

const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  const code = (err as { code?: string }).code;
  return code === "ABORT_ERR" || code === "ERR_ABORTED";
}

function statusFromError(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const s = (err as { status?: unknown }).status;
  return typeof s === "number" ? s : null;
}

function isRetryableError(err: unknown): boolean {
  if (isAbortError(err)) return false;
  const status = statusFromError(err);
  if (status != null) return RETRYABLE_HTTP_STATUSES.has(status);
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  if (typeof code === "string" && RETRYABLE_NETWORK_CODES.has(code)) return true;
  // Heuristic: fetch failures land as TypeError with cause; the OpenAI SDK
  // wraps connection errors in APIConnectionError without a status.
  if (err.name === "APIConnectionError" || err.name === "APIConnectionTimeoutError") {
    return true;
  }
  return false;
}

function readHeader(headers: unknown, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as { get?: unknown }).get === "function") {
    const v = (headers as { get: (n: string) => string | null }).get(name);
    return v ?? null;
  }
  if (typeof headers === "object") {
    const lc = name.toLowerCase();
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (k.toLowerCase() === lc && typeof v === "string") return v;
    }
  }
  return null;
}

function parseRetryAfterMs(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const headers = (err as { headers?: unknown }).headers;
  const ms = readHeader(headers, "retry-after-ms");
  if (ms) {
    const n = parseFloat(ms);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const sec = readHeader(headers, "retry-after");
  if (sec) {
    const n = parseFloat(sec);
    if (Number.isFinite(n) && n >= 0) return n * 1000;
    const dateMs = Date.parse(sec) - Date.now();
    if (Number.isFinite(dateMs) && dateMs >= 0) return dateMs;
  }
  return null;
}

function computeScheduledWait(retryNumber: number, intervals: number[]): number {
  if (intervals.length === 0) return 0;
  const base = intervals[Math.min(retryNumber - 1, intervals.length - 1)]!;
  // Equal jitter: 75-100% of base. Never extends the listed value.
  return base * (0.75 + Math.random() * 0.25);
}

function abortReason(signal: AbortSignal): Error {
  return toAbortError(signal.reason);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface CallWithRetryContext {
  budgetName: NetworkBudgetName;
  budget: NetworkBudget;
  signal?: AbortSignal | undefined;
  logger?: Logger | undefined;
}

/**
 * Invoke `fn` with retry on transient failures. Honors `Retry-After` headers
 * over the configured schedule. Aborts immediately when `signal` fires.
 *
 * `fn` is responsible for its own per-attempt timeout — the OpenAI SDK accepts
 * `{ timeout, signal }` per request; `fetchWithBudget` builds its own combined
 * AbortSignal. This keeps the retry layer pure.
 */
export async function callWithRetry<T>(
  ctx: CallWithRetryContext,
  fn: () => Promise<T>,
): Promise<T> {
  const { budget, budgetName, signal, logger } = ctx;
  let attempt = 0;
  for (;;) {
    if (signal?.aborted) throw abortReason(signal);
    try {
      return await fn();
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) {
        throw toAbortError(signal?.aborted ? (signal.reason ?? err) : err);
      }
      const remaining = budget.maxRetries - attempt;
      if (remaining <= 0) throw err;
      if (!isRetryableError(err)) throw err;
      const headerWait = parseRetryAfterMs(err);
      const scheduledWait = computeScheduledWait(
        attempt + 1,
        budget.retryIntervals,
      );
      const waitMs = headerWait != null ? headerWait : scheduledWait;
      attempt += 1;
      if (logger) {
        await logger.warn(
          "retry",
          `retrying ${budgetName} after ${Math.round(waitMs)}ms`,
          {
            budget: budgetName,
            attempt,
            maxRetries: budget.maxRetries,
            waitMs: Math.round(waitMs),
            reason:
              statusFromError(err) ??
              (err instanceof Error ? err.name : "unknown"),
            retryAfterHeader: headerWait != null,
          },
        );
      }
      await abortableSleep(waitMs, signal);
    }
  }
}
