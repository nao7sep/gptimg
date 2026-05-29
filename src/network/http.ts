/**
 * Low-level HTTP attempt primitives shared by the in-memory fetch path
 * (network/fetch.ts) and the streamed model download (local/models/fetch.ts).
 * Both need the same two things: a status-bearing error the retry layer can
 * classify, and a way to bound a single attempt with a timeout.
 */

/**
 * Thrown on a non-2xx response. Carries `status` and `headers` so the retry
 * layer can decide retryability and honor `Retry-After`.
 */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly headers: Headers;
  constructor(status: number, headers: Headers, body: string) {
    super(`HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ""}`);
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
