import { Buffer } from "node:buffer";
import { cancelledError } from "../../errors.ts";
import type { Logger } from "../../events/index.ts";
import type { NetworkBudget } from "../../network/defaults.ts";
import { isAbortError } from "../../network/failure.ts";
import { fetchWithBudget } from "../../network/fetch.ts";
import type { ProviderImageResult } from "../types.ts";

/**
 * The images endpoint's items as bytes, in response order: base64 decoded, a
 * URL fetched on the download budget. An item that cannot be had is a failed
 * item, so its position still maps to its file index; a cancellation while
 * fetching stops the call, with the images already paid for.
 */
export async function materializeImages(
  items: ReadonlyArray<{ b64_json?: string | null; url?: string | null }>,
  download: NetworkBudget,
  signal: AbortSignal | undefined,
  logger: Logger | undefined,
): Promise<ProviderImageResult["images"]> {
  return Promise.all(
    items.map(async (item) => {
      if (typeof item.b64_json === "string" && item.b64_json.length > 0) {
        return { data: new Uint8Array(Buffer.from(item.b64_json, "base64")) };
      }
      if (typeof item.url === "string" && item.url.length > 0) {
        try {
          return { data: await fetchWithBudget(item.url, download, { signal, logger }) };
        } catch (err) {
          // The images were paid for; stopping now may lose them.
          if (isAbortError(err)) throw cancelledError(err, "unknown");
          return { data: null, error: `Failed to fetch image from URL: ${(err as Error).message}` };
        }
      }
      return { data: null, error: "Response item contained neither b64_json nor url" };
    }),
  );
}
