import { truncate } from "../internal/textCleanup.js";

/**
 * Low-level HTTP attempt primitives shared by the in-memory fetch path
 * (network/fetch.ts) and the streamed model download (local/models/fetch.ts).
 * Both need the same two things: a status-bearing error the retry layer can
 * classify, and a way to bound a single attempt with a timeout.
 */

const BODY_EXCERPT_GRAPHEMES = 200;

/**
 * Thrown on a non-2xx response. Carries `status` and `headers` so the retry
 * layer can decide retryability and honor `Retry-After`.
 *
 * The message carries a one-line excerpt of the body. A longer body ends in
 * "..." so a reader never mistakes the excerpt for the whole response; three
 * periods rather than U+2026 because this text reaches callers' terminals, whose
 * console encoding is not guaranteed (localization-conventions, *Ellipsis*).
 */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly headers: Headers;
  constructor(status: number, headers: Headers, body: string) {
    const excerpt = truncate(body, BODY_EXCERPT_GRAPHEMES);
    super(`HTTP ${status}${excerpt.text ? `: ${excerpt.text}${excerpt.truncated ? "..." : ""}` : ""}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.headers = headers;
  }
}

/**
 * Combine a caller's abort signal with a per-attempt timeout into one signal.
 * `AbortSignal.timeout` uses an unref'd timer, so a still-pending timeout does
 * not keep the process alive after the attempt resolves — no cleanup needed.
 */
export function combineSignals(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const signals: AbortSignal[] = [];
  if (parent) signals.push(parent);
  if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (signals.length === 0) return new AbortController().signal;
  if (signals.length === 1) return signals[0]!;
  return AbortSignal.any(signals);
}
