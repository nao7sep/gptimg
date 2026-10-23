import type { Logger } from "../events/index.ts";
import { diagnosticOf } from "../events/diagnostic.ts";
import type { AttemptFields, FailedAttemptFields } from "../types.ts";
import { cancelledError } from "../errors.ts";
import { isQuotaExhausted } from "./classify.ts";
import { UNREACHABLE_CODES, isAbortError, isConnectionError, isTimeout, networkCode } from "./failure.ts";
import {
  BUDGET_RESEND_POLICY,
  type NetworkBudget,
  type NetworkBudgetName,
  type ResendPolicy,
} from "./defaults.ts";

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

function statusFromError(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const s = (err as { status?: unknown }).status;
  return typeof s === "number" ? s : null;
}

// Failures that prove a request never reached the provider's work: it was
// refused, could not be resolved (UNREACHABLE_CODES), or was rejected as over
// capacity before any processing. Everything else in the transient sets may
// have been processed.
const UNPROCESSED_HTTP_STATUSES = new Set([408, 429, 503]);
function isRetryableError(err: unknown, policy: ResendPolicy): boolean {
  if (isAbortError(err)) return false;
  // An exhausted quota is a 429 that waiting cannot fix (sdk-conventions, *Retries*).
  if (isQuotaExhausted(err)) return false;
  const status = statusFromError(err);
  if (status != null) {
    return policy === "unprocessed"
      ? UNPROCESSED_HTTP_STATUSES.has(status)
      : RETRYABLE_HTTP_STATUSES.has(status);
  }
  if (!(err instanceof Error)) return false;
  const code = networkCode(err);
  if (policy === "unprocessed") {
    return code != null && UNREACHABLE_CODES.has(code);
  }
  if (code != null && RETRYABLE_NETWORK_CODES.has(code)) return true;
  // A timeout, or the OpenAI client's connection failure, which carries no status
  // and keeps the generic error name, so it is told by its class.
  return isTimeout(err) || isConnectionError(err);
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
  return cancelledError(signal.reason);
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
   * event carries it (data-lifecycle-conventions, *Records* and *Nothing is
   * cut*).
   */
  request?: Record<string, unknown> | undefined;
  /**
   * What a successful attempt's event records as its response. A call
   * without it, a download whose bytes the caller keeps, emits no event for a
   * successful attempt.
   */
  response?: ((result: T) => Record<string, unknown>) | undefined;
}

/** What one attempt's event records about the attempt itself. */
function attemptFields(ctx: CallWithRetryContext<never>, attempt: number, started: number): AttemptFields {
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

/** What one failed attempt's event records about the attempt and its failure. */
function failedAttemptFields(
  ctx: CallWithRetryContext<never>,
  attempt: number,
  started: number,
  err: unknown,
): FailedAttemptFields {
  const response = failedResponseFields(err);
  return {
    ...attemptFields(ctx, attempt, started),
    status: statusFromError(err),
    error: diagnosticOf(err),
    ...(response && { response }),
  };
}

/**
 * Invoke `fn` with retry on failures the budget's resend policy allows
 * (`BUDGET_RESEND_POLICY`): any transient failure for downloads, only provably
 * unprocessed ones for paid provider calls. Honors `Retry-After` headers
 * over the configured schedule. Aborts immediately when `signal` fires.
 *
 * Each attempt is its own event: `attempt.succeeded` with the response before
 * the result is returned, `attempt.retrying` for a retried one,
 * `attempt.failed` for the last failed one before the failure is rethrown,
 * and `attempt.cancelled`.
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
        logger?.emit("info", "cancelled", { event: "attempt.cancelled", ...attemptFields(ctx, attempt + 1, started) });
        // A paid request in flight may already have been accepted.
        throw cancelledError(
          signal?.aborted ? (signal.reason ?? err) : err,
          BUDGET_RESEND_POLICY[budgetName] === "unprocessed" ? "unknown" : "none",
        );
      }
      const remaining = budget.maxRetries - attempt;
      if (remaining <= 0 || !isRetryableError(err, BUDGET_RESEND_POLICY[budgetName])) {
        logger?.emit("warn", "response", { event: "attempt.failed", ...failedAttemptFields(ctx, attempt + 1, started, err) });
        throw err;
      }
      const headerWait = parseRetryAfterMs(err);
      const scheduledWait = computeScheduledWait(
        attempt + 1,
        budget.retryIntervals,
      );
      // Retry-After is the provider's minimum delay. If it exceeds our bounded
      // wait, surface this failure instead of resending before it permits us.
      const retryAfterCap = Math.min(budget.timeout, 30_000);
      if (headerWait != null && headerWait > retryAfterCap) {
        logger?.emit("warn", "response", { event: "attempt.failed", ...failedAttemptFields(ctx, attempt + 1, started, err) });
        throw err;
      }
      const waitMs = headerWait ?? scheduledWait;
      attempt += 1;
      logger?.emit("warn", "retry", {
        event: "attempt.retrying",
        ...failedAttemptFields(ctx, attempt, started, err),
        waitMs: Math.round(waitMs),
        retryAfterHeader: headerWait != null,
        retryAfterCapped: false,
      });
      await abortableSleep(waitMs, signal);
      continue;
    }
    if (ctx.response) {
      logger?.emit("info", "response", { event: "attempt.succeeded", ...attemptFields(ctx, attempt + 1, started), response: ctx.response(result) });
    }
    return result;
  }
}
