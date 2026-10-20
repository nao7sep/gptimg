import path from "node:path";
import { processingError } from "../../errors.ts";
import { maskDiagnosticCopy } from "../../events/mask.ts";
import { classifyRequestFailure } from "../../network/classify.ts";
import { callWithRetry } from "../../network/retry.ts";
import type { EditProviderArgs, ProviderImageResult } from "../types.ts";
import { buildOpenAIClient, clientHeaders, recordedResponse, resolveModel } from "./client.ts";
import { defaultModelFor } from "../../ai-models.ts";
import { buildImageRequest } from "./request.ts";
import { materializeImages } from "./images.ts";
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

  return { raw: response, images: await materializeImages(response.data ?? [], download, signal, logger) };
}
