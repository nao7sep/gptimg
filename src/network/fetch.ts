import type { Logger } from "../log/index.js";
import type { NetworkBudget } from "./defaults.js";
import { combineSignals, HttpStatusError } from "./http.js";
import { callWithRetry } from "./retry.js";

async function fetchOnce(
  url: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const res = await fetch(url, { signal: combineSignals(signal, timeoutMs) });
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
