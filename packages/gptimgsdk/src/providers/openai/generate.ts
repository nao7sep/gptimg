import { Buffer } from "node:buffer";

import { cancelledError } from "../../errors.ts";
import { maskDiagnosticCopy } from "../../log/mask.ts";
import { classifyRequestFailure } from "../../network/classify.ts";
import { fetchWithBudget } from "../../network/fetch.ts";
import { callWithRetry, isAbortError } from "../../network/retry.ts";
import type { GenerateProviderArgs, ProviderImageResult } from "../types.ts";
import { buildOpenAIClient, clientHeaders, recordedResponse, resolveModel } from "./client.ts";
import { defaultModelFor } from "../../ai-models.ts";
import { buildImageRequest } from "./request.ts";

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
  const model = resolveModel(args.params.model, defaultModelFor("openai", "image-generate"));

  const params = buildImageRequest(model, {
    ...args.params,
    model,
    prompt: args.prompt,
  });

  const request = { headers: clientHeaders(client), body: params };

  const { primary, download, logger, signal } = args.network;
  // Every record of this call, and any echo in an error, masks the key.
  logger?.addCredential(args.profile.apiKey);

  let response: { data?: Array<{ b64_json?: string | null; url?: string | null }> };
  try {
    response = (
      await callWithRetry(
        { budgetName: "imageGenerate", budget: primary, signal, logger, request, response: recordedResponse },
        () =>
          client.images.generate(params as never, {
            timeout: primary.timeout,
            maxRetries: 0,
            signal,
          }).withResponse(),
      )
    ).data as never;
  } catch (err) {
    throw classifyRequestFailure(maskDiagnosticCopy(err, [args.profile.apiKey]), "imageGenerate", "OpenAI images.generate", [args.profile.apiKey]);
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
          // The images were paid for; stopping now may lose them.
          if (isAbortError(err)) throw cancelledError(err, "unknown");
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
