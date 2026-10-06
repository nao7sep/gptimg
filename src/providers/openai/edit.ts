import { Buffer } from "node:buffer";
import path from "node:path";
import { LocalOpError, ProviderError } from "../../errors.js";
import { fetchWithBudget } from "../../network/fetch.js";
import { callWithRetry, isAbortError } from "../../network/retry.js";
import type { EditProviderArgs, ProviderImageResult } from "../types.js";
import { buildOpenAIClient, profileHeaders, recordedResponse, resolveModel } from "./client.js";
import { defaultModelFor } from "../../ai-models.js";
import { buildImageRequest } from "./request.js";
import { imageFileForEditUpload } from "./upload.js";

export async function openaiEdit(
  args: EditProviderArgs,
): Promise<ProviderImageResult> {
  const client = buildOpenAIClient(args.profile);
  const model = resolveModel(args.params.model, defaultModelFor("openai", "image-edit"));

  let imageFile;
  let maskFile;
  try {
    imageFile = await imageFileForEditUpload(args.imagePath, "input");
    maskFile = args.maskPath
      ? await imageFileForEditUpload(args.maskPath, "mask")
      : undefined;
  } catch (err) {
    if (err instanceof LocalOpError) throw err;
    throw new LocalOpError(
      "image.readFailed",
      `Failed to read edit input image: ${(err as Error).message}`,
      { cause: err },
    );
  }

  const params = buildImageRequest(model, {
    ...args.params,
    model,
    prompt: args.prompt,
    image: imageFile,
    ...(maskFile && { mask: maskFile }),
  });

  // The uploads are recorded by file name: those files already hold their bytes.
  const request = {
    headers: profileHeaders(args.profile),
    body: {
      ...params,
      image: path.basename(args.imagePath),
      ...(args.maskPath && { mask: path.basename(args.maskPath) }),
    },
  };

  const { primary, download, logger, signal } = args.network;

  let response: { data?: Array<{ b64_json?: string | null; url?: string | null }> };
  try {
    response = (
      await callWithRetry(
        { budgetName: "imageGenerate", budget: primary, signal, logger, request, response: recordedResponse },
        () =>
          client.images.edit(params as never, {
            timeout: primary.timeout,
            maxRetries: 0,
            signal,
          }).withResponse(),
      )
    ).data as never;
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
