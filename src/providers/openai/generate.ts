import { Buffer } from "node:buffer";
import { ProviderError } from "../../errors.js";
import { fetchWithBudget } from "../../network/fetch.js";
import { callWithRetry, isAbortError } from "../../network/retry.js";
import type { GenerateProviderArgs, ProviderImageResult } from "../types.js";
import { buildOpenAIClient, resolveModel } from "./client.js";
import { OPENAI_MODEL_DEFAULTS, shouldOmitResponseFormat } from "./defaults.js";

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

  if (shouldOmitResponseFormat(model)) {
    delete params.response_format;
  } else if (params.response_format == null) {
    params.response_format = "b64_json";
  }

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
