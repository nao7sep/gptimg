import { Buffer } from "node:buffer";
import { ProviderError } from "../../errors.js";
import type { GenerateProviderArgs, ProviderImageResult } from "../types.js";
import { buildOpenAIClient, resolveModel } from "./client.js";

const DEFAULT_GENERATE_MODEL = "gpt-image-1";

function shouldOmitResponseFormat(model: string): boolean {
  // gpt-image-1 always returns base64 and rejects response_format.
  return model.startsWith("gpt-image");
}

async function fetchUrlToBytes(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

export async function openaiGenerate(
  args: GenerateProviderArgs,
): Promise<ProviderImageResult> {
  const client = buildOpenAIClient(args.profile);
  const model = resolveModel(
    args.params.model,
    args.profile.redacted.model,
    DEFAULT_GENERATE_MODEL,
  );

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

  let response: { data?: Array<{ b64_json?: string | null; url?: string | null }> };
  try {
    response = (await client.images.generate(params as never)) as never;
  } catch (err) {
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
        const bytes = await fetchUrlToBytes(item.url);
        if (bytes) return { data: bytes };
        return { data: null, error: "Failed to fetch image from URL" };
      }
      return { data: null, error: "Response item contained neither b64_json nor url" };
    }),
  );

  return { raw: response, images };
}
