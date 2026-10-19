import type { Logger } from "../events/index.ts";
import type { NetworkBudget } from "./defaults.ts";
import { combineSignals, HttpStatusError } from "./http.ts";
import { callWithRetry } from "./retry.ts";
import { urlQueryValues } from "../events/mask.ts";

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
  // A signed image URL carries its credential in the query; every record of
  // the call masks those values, including echoes in an error body.
  for (const value of urlQueryValues(url)) opts.logger?.addCredential(value);
  return callWithRetry(
    {
      budgetName: "imageDownload",
      budget,
      signal: opts.signal,
      logger: opts.logger,
      request: { url },
    },
    () => fetchOnce(url, budget.timeout, opts.signal),
  );
}
