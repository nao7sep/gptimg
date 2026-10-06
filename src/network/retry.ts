import type { Logger } from "../log/index.js";
import { toAbortError } from "../errors.js";
import {
  BUDGET_RESEND_POLICY,
  type NetworkBudget,
  type NetworkBudgetName,
  type ResendPolicy,
} from "./defaults.js";

// Standard transient statuses plus Cloudflare-origin 5xx codes. 408 (request
// timeout) and 429 (rate limit) are transient by definition; 520-524 are
// transient connection/timeout failures; 525 (SSL handshake) is often a
// transient network blip; 530 is an ambiguous origin/DNS error that is
// frequently transient. 526 (invalid SSL certificate) and 501 are persistent
// config errors and are intentionally NOT retried — retrying cannot fix them.
// 409 (conflict) is a deterministic state error for this toolkit's endpoints,
// not a transient boundary, so it is not retried either. (527 is the retired
// Railgun error and no longer issued.)
const RETRYABLE_HTTP_STATUSES = new Set([
  408, 429,
  500, 502, 503, 504,
  520, 521, 522, 523, 524, 525, 530,
]);
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

// Failures that prove a request never reached the provider's work: it was
// refused, could not be resolved, or was rejected as over capacity before any
// processing. Everything else in the transient sets may have been processed.
const UNPROCESSED_HTTP_STATUSES = new Set([408, 429, 503]);
const UNPROCESSED_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * The first string `code` on the error or its `cause` chain. The OpenAI SDK
 * wraps a fetch failure in APIConnectionError, and fetch wraps the socket
 * error in a TypeError, so the system code sits two causes deep.
 */
function networkCode(err: unknown): string | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur && typeof cur === "object"; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

function isRetryableError(err: unknown, policy: ResendPolicy): boolean {
  if (isAbortError(err)) return false;
  const status = statusFromError(err);
  if (status != null) {
    return policy === "unprocessed"
      ? UNPROCESSED_HTTP_STATUSES.has(status)
      : RETRYABLE_HTTP_STATUSES.has(status);
  }
  if (!(err instanceof Error)) return false;
  const code = networkCode(err);
  if (policy === "unprocessed") {
    return code != null && UNPROCESSED_NETWORK_CODES.has(code);
  }
  if (code != null && RETRYABLE_NETWORK_CODES.has(code)) return true;
  if (err.name === "TimeoutError") return true;
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

export interface CallWithRetryContext<T = unknown> {
  budgetName: NetworkBudgetName;
  budget: NetworkBudget;
  signal?: AbortSignal | undefined;
  logger?: Logger | undefined;
  /**
   * The request each attempt sends, headers and key included; every attempt's
   * log line carries it (data-lifecycle-conventions, *Records* and *Nothing is
   * cut*).
   */
  request?: Record<string, unknown> | undefined;
  /**
   * What a successful attempt's log line records as its response. A call
   * without it, a download whose bytes the caller keeps, logs no line for a
   * successful attempt.
   */
  response?: ((result: T) => unknown) | undefined;
}

/** What one attempt's log line records about the attempt itself. */
function attemptFields(ctx: CallWithRetryContext<never>, attempt: number, started: number): Record<string, unknown> {
  return {
    budget: ctx.budgetName,
    attempt,
    maxRetries: ctx.budget.maxRetries,
    durationMs: Math.round(performance.now() - started),
    ...(ctx.request ? { request: ctx.request } : {}),
  };
}

/**
 * The provider's own answer that a failed request's error holds, as the SDK
 * read it: status, headers, request id and JSON body, each only when present.
 * A failure that got no response, such as a refused connection, has none.
 */
export function failedResponseFields(err: unknown): Record<string, unknown> | undefined {
  if (!err || typeof err !== "object") return undefined;
  const { headers, error, requestID } = err as { headers?: unknown; error?: unknown; requestID?: unknown };
  if (headers === undefined && error === undefined) return undefined;
  const status = statusFromError(err);
  return {
    ...(status !== null && { status }),
    ...(headers !== undefined && { headers: headers instanceof Headers ? Object.fromEntries(headers) : headers }),
    ...(requestID !== undefined && { requestId: requestID }),
    ...(error !== undefined && { body: error }),
  };
}

/** What one failed attempt's log line records about the attempt and its failure. */
function failedAttemptFields(
  ctx: CallWithRetryContext<never>,
  attempt: number,
  started: number,
  err: unknown,
): Record<string, unknown> {
  const response = failedResponseFields(err);
  return {
    ...attemptFields(ctx, attempt, started),
    status: statusFromError(err),
    error: {
      name: err instanceof Error ? err.name : typeof err,
      message: err instanceof Error ? err.message : String(err),
      code: networkCode(err),
    },
    ...(response && { response }),
  };
}

/**
 * Invoke `fn` with retry on failures the budget's resend policy allows
 * (`BUDGET_RESEND_POLICY`): any transient failure for downloads, only provably
 * unprocessed ones for paid provider calls. Honors `Retry-After` headers
 * over the configured schedule. Aborts immediately when `signal` fires.
 *
 * Each attempt is its own log line: a successful one that records a response
 * as a `response` line before its result is returned, a retried one as the
 * `retry` line, the last
 * failed one as a `response` line before the failure is rethrown, and a
 * cancelled one as a `cancelled` line.
 *
 * `fn` is responsible for its own per-attempt timeout — the OpenAI SDK accepts
 * `{ timeout, signal }` per request; `fetchWithBudget` builds its own combined
 * AbortSignal. This keeps the retry layer pure.
 */
export async function callWithRetry<T>(
  ctx: CallWithRetryContext<T>,
  fn: () => Promise<T>,
): Promise<T> {
  const { budget, budgetName, signal, logger } = ctx;
  let attempt = 0;
  for (;;) {
    if (signal?.aborted) throw abortReason(signal);
    const started = performance.now();
    let result: T;
    try {
      result = await fn();
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) {
        if (logger) {
          await logger.info("cancelled", `${budgetName} attempt ${attempt + 1} cancelled`, {
            ...attemptFields(ctx, attempt + 1, started),
            outcome: "cancelled",
          });
        }
        throw toAbortError(signal?.aborted ? (signal.reason ?? err) : err);
      }
      const remaining = budget.maxRetries - attempt;
      if (remaining <= 0 || !isRetryableError(err, BUDGET_RESEND_POLICY[budgetName])) {
        if (logger) {
          await logger.warn(
            "response",
            `${budgetName} attempt ${attempt + 1} failed`,
            failedAttemptFields(ctx, attempt + 1, started, err),
          );
        }
        throw err;
      }
      const headerWait = parseRetryAfterMs(err);
      const scheduledWait = computeScheduledWait(
        attempt + 1,
        budget.retryIntervals,
      );
      // Retry-After is untrusted external input. It may ask for a useful short
      // delay, but it cannot expand the caller's explicit time budget into an
      // hours- or days-long wait. The per-attempt timeout is the cap.
      const retryAfterCapped = headerWait != null && headerWait > budget.timeout;
      const waitMs = headerWait != null
        ? Math.min(headerWait, budget.timeout)
        : scheduledWait;
      attempt += 1;
      if (logger) {
        await logger.warn(
          "retry",
          `retrying ${budgetName} after ${Math.round(waitMs)}ms`,
          {
            ...failedAttemptFields(ctx, attempt, started, err),
            waitMs: Math.round(waitMs),
            retryAfterHeader: headerWait != null,
            retryAfterCapped,
          },
        );
      }
      await abortableSleep(waitMs, signal);
      continue;
    }
    if (logger && ctx.response) {
      await logger.info("response", `${budgetName} attempt ${attempt + 1} succeeded`, {
        ...attemptFields(ctx, attempt + 1, started),
        outcome: "succeeded",
        response: ctx.response(result),
      });
    }
    return result;
  }
}
