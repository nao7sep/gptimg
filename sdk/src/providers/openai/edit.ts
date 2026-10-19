import { Buffer } from "node:buffer";
import path from "node:path";
import { cancelledError, processingError } from "../../errors.ts";
import { maskDiagnosticCopy } from "../../log/mask.ts";
import { classifyRequestFailure } from "../../network/classify.ts";
import { fetchWithBudget } from "../../network/fetch.ts";
import { callWithRetry, isAbortError } from "../../network/retry.ts";
import type { EditProviderArgs, ProviderImageResult } from "../types.ts";
import { buildOpenAIClient, clientHeaders, recordedResponse, resolveModel } from "./client.ts";
import { defaultModelFor } from "../../ai-models.ts";
import { buildImageRequest } from "./request.ts";
import { imageFileForEditUpload } from "./upload.ts";

export async function openaiEdit(
  args: EditProviderArgs,
): Promise<ProviderImageResult> {
  const client = buildOpenAIClient(args.credentials);
  const model = resolveModel(args.params.model, defaultModelFor("openai", "image-edit"));

  let imageFile;
  let maskFile;
  try {
    imageFile = await imageFileForEditUpload(args.imagePath, "input");
    maskFile = args.maskPath
      ? await imageFileForEditUpload(args.maskPath, "mask")
      : undefined;
  } catch (err) {
    throw processingError(err, "Failed to prepare edit input image", args.imagePath, "none");
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
    headers: clientHeaders(client),
    body: {
      ...params,
      image: path.basename(args.imagePath),
      ...(args.maskPath && { mask: path.basename(args.maskPath) }),
    },
  };

  const { primary, download, logger, signal } = args.network;
  // Every record of this call, and any echo in an error, masks the key.
  logger?.addCredential(args.credentials.apiKey);

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
    throw classifyRequestFailure(maskDiagnosticCopy(err, [args.credentials.apiKey]), "imageGenerate", "OpenAI images.edit", [args.credentials.apiKey]);
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
