import { Buffer } from "node:buffer";
import { createReadStream } from "node:fs";
import { toFile } from "openai";
import { ProviderError } from "../../errors.js";
import { fetchWithBudget } from "../../network/fetch.js";
import { callWithRetry, isAbortError } from "../../network/retry.js";
import type { EditProviderArgs, ProviderImageResult } from "../types.js";
import { buildOpenAIClient, resolveModel } from "./client.js";

const DEFAULT_EDIT_MODEL = "gpt-image-2";

export async function openaiEdit(
  args: EditProviderArgs,
): Promise<ProviderImageResult> {
  const client = buildOpenAIClient(args.profile);
  const model = resolveModel(
    args.params.model,
    args.profile.redacted.model,
    DEFAULT_EDIT_MODEL,
  );

  const imageFile = await toFile(createReadStream(args.imagePath));
  const maskFile = args.maskPath
    ? await toFile(createReadStream(args.maskPath))
    : undefined;

  const params: Record<string, unknown> = {
    ...args.params,
    model,
    prompt: args.prompt,
    image: imageFile,
  };
  if (maskFile) params.mask = maskFile;
  if (model.startsWith("gpt-image")) {
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
        client.images.edit(params as never, {
          timeout: primary.timeout,
          maxRetries: 0,
          signal,
        }),
    )) as never;
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new ProviderError(
      "provider.requestFailed",
      `OpenAI images.edit failed: ${(err as Error).message}`,
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
