import type { Logger } from "../log/index.js";
import type { NetworkBudget } from "./defaults.js";
import { callWithRetry } from "./retry.js";

class HttpStatusError extends Error {
  readonly status: number;
  readonly headers: Headers;
  constructor(status: number, headers: Headers, body: string) {
    super(`HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.headers = headers;
  }
}

function combineSignals(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const signals: AbortSignal[] = [];
  if (parent) signals.push(parent);
  if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (signals.length === 0) {
    const ac = new AbortController();
    return { signal: ac.signal, cleanup: () => {} };
  }
  if (signals.length === 1) return { signal: signals[0]!, cleanup: () => {} };
  return { signal: AbortSignal.any(signals), cleanup: () => {} };
}

async function fetchOnce(
  url: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const combined = combineSignals(signal, timeoutMs);
  try {
    const res = await fetch(url, { signal: combined.signal });
    if (!res.ok) {
      let body = "";
      try {
        body = await res.text();
      } catch {
        // ignore
      }
      throw new HttpStatusError(res.status, res.headers, body);
    }
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    combined.cleanup();
  }
}

/**
 * Fetch `url` into bytes, applying the given retry/timeout budget. Throws on
 * non-2xx response (the thrown error carries `status` and `headers` for the
 * retry layer to honor `Retry-After`).
 */
export async function fetchWithBudget(
  url: string,
  budget: NetworkBudget,
  opts: { signal?: AbortSignal | undefined; logger?: Logger | undefined } = {},
): Promise<Uint8Array> {
  return callWithRetry(
    {
      budgetName: "imageDownload",
      budget,
      signal: opts.signal,
      logger: opts.logger,
    },
    () => fetchOnce(url, budget.timeout, opts.signal),
  );
}
