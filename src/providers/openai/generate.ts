import { Buffer } from "node:buffer";
import { ProviderError } from "../../errors.js";
import { fetchWithBudget } from "../../network/fetch.js";
import { callWithRetry, isAbortError } from "../../network/retry.js";
import type { GenerateProviderArgs, ProviderImageResult } from "../types.js";
import { buildOpenAIClient, resolveModel } from "./client.js";
import { OPENAI_MODEL_DEFAULTS } from "./defaults.js";

/**
 * `response_format` is never sent, and never stripped from a caller who sends it.
 * The whole images endpoint rejects the parameter now ("400 Unknown parameter") —
 * gpt-image-* always returned base64 anyway, and the DALL-E models the old
 * inject-it branch existed for no longer exist at all. Injecting it only masked
 * that: the parameter error fired first and reported "Unknown parameter" for a
 * parameter the caller never set, hiding "the model does not exist".
 * The url branch below stays: it costs nothing and a response is not ours to
 * predict.
 */
export async function openaiGenerate(
  args: GenerateProviderArgs,
): Promise<ProviderImageResult> {
  const client = buildOpenAIClient(args.profile);
  const model = resolveModel(args.params.model, OPENAI_MODEL_DEFAULTS.generate);

  const params: Record<string, unknown> = {
    ...args.params,
    model,
    prompt: args.prompt,
  };

  const { primary, download, logger, signal } = args.network;

  let response: { data?: Array<{ b64_json?: string | null; url?: string | null }> };
  try {
    response = (await callWithRetry(
      { budgetName: "imageGenerate", budget: primary, signal, logger },
      () =>
        client.images.generate(params as never, {
          timeout: primary.timeout,
          maxRetries: 0,
          signal,
        }),
    )) as never;
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new ProviderError(
      "provider.requestFailed",
      `OpenAI images.generate failed: ${(err as Error).message}`,
      { cause: err },
    );
  }

  const data = response.data ?? [];
  const images = await Promise.all(
    data.map(async (item) => {
      if (typeof item.b64_json === "string" && item.b64_json.length > 0) {
        return { data: new Uint8Array(Buffer.from(item.b64_json, "base64")) };
      }
      if (typeof item.url === "string" && item.url.length > 0) {
        try {
          const bytes = await fetchWithBudget(item.url, download, {
            signal,
            logger,
          });
          return { data: bytes };
        } catch (err) {
          if (isAbortError(err)) throw err;
          return {
            data: null,
            error: `Failed to fetch image from URL: ${(err as Error).message}`,
          };
        }
      }
      return { data: null, error: "Response item contained neither b64_json nor url" };
    }),
  );

  return { raw: response, images };
}
