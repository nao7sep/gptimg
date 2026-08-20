import { Buffer } from "node:buffer";
import { ProviderError } from "../../errors.js";
import { callWithRetry, isAbortError } from "../../network/retry.js";
import type { VisionVerdict } from "../../types.js";
import type { ProviderVisionResult, VisionProviderArgs } from "../types.js";
import { buildOpenAIClient, resolveModel } from "./client.js";
import { OPENAI_MODEL_DEFAULTS, OPENAI_VISION_SYSTEM_PROMPT } from "./defaults.js";

const VERDICT_SCHEMA = {
  name: "VisionVerdict",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ok: { type: "boolean" },
      score: { type: "number" },
      reasons: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["ok", "score", "reasons"],
  },
} as const;

function mimeFromFormat(format: string): string {
  if (format === "jpg") return "image/jpeg";
  return `image/${format}`;
}

/**
 * `detail` is passed through untouched. The model is free text, so this layer
 * cannot know an arbitrary model's capabilities — and it does not need to: the API
 * validates the field and names the legal values in its own 400 ("one of ['low',
 * 'auto', 'high', 'original']"). A local gate here was worse than no gate; it
 * refused detail=original on the -mini models, which accept it.
 */
function imageContentParts(images: VisionProviderArgs["images"]) {
  return images.map((img) => ({
    type: "image_url" as const,
    image_url: {
      url: `data:${mimeFromFormat(img.format)};base64,${Buffer.from(img.data).toString("base64")}`,
      ...(img.detail ? { detail: img.detail } : {}),
    },
  }));
}

/**
 * Parse the model's structured verdict. An unparseable, empty, or off-schema
 * response is a provider fault, not a negative verdict — throw so it surfaces
 * as a runtime error rather than masquerading as "the image failed the check".
 * `ok: false` is reserved for a genuine verdict from the model.
 */
function parseVerdict(raw: string | null | undefined): VisionVerdict {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ProviderError(
      "provider.invalidResponse",
      "Vision model returned an empty response.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ProviderError(
      "provider.invalidResponse",
      "Vision model response was not valid JSON.",
      { cause: err },
    );
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    typeof (parsed as { ok?: unknown }).ok === "boolean" &&
    typeof (parsed as { score?: unknown }).score === "number" &&
    Array.isArray((parsed as { reasons?: unknown }).reasons)
  ) {
    const v = parsed as { ok: boolean; score: number; reasons: unknown[] };
    return {
      ok: v.ok,
      // The schema declares score as a number but does not bound it; clamp
      // so a stray out-of-range value can't propagate to callers.
      score: Math.max(0, Math.min(1, v.score)),
      reasons: v.reasons.map((r) => String(r)),
    };
  }
  throw new ProviderError(
    "provider.invalidResponse",
    "Vision model response did not match the verdict schema.",
  );
}

export async function openaiVision(
  args: VisionProviderArgs,
): Promise<ProviderVisionResult> {
  const model = resolveModel(args.params.model, OPENAI_MODEL_DEFAULTS.vision);
  const client = buildOpenAIClient(args.profile);

  const { systemPrompt: paramsSystemPrompt, ...passthroughParams } = args.params;
  const systemPrompt =
    typeof paramsSystemPrompt === "string" && paramsSystemPrompt.length > 0
      ? paramsSystemPrompt
      : OPENAI_VISION_SYSTEM_PROMPT;

  const messages = [
    { role: "system" as const, content: systemPrompt },
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: args.check },
        ...imageContentParts(args.images),
      ],
    },
  ];

  const params: Record<string, unknown> = {
    ...passthroughParams,
    model,
    messages,
    response_format: {
      type: "json_schema",
      json_schema: VERDICT_SCHEMA,
    },
  };

  const { primary, logger, signal } = args.network;

  let response: {
    choices?: Array<{
      finish_reason?: string | null;
      message?: { content?: string | null; refusal?: string | null };
    }>;
  };
  try {
    response = (await callWithRetry(
      { budgetName: "imageVision", budget: primary, signal, logger },
      () =>
        client.chat.completions.create(params as never, {
          timeout: primary.timeout,
          maxRetries: 0,
          signal,
        }),
    )) as never;
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new ProviderError(
      "provider.requestFailed",
      `OpenAI chat.completions.create failed: ${(err as Error).message}`,
      { cause: err },
    );
  }

  // The provider's own account of a result that is not what was asked for, read BEFORE the
  // content (ai-model-routing-conventions: *never invent a cause the provider gave you*). A
  // refusal arrives as a `refusal` string with null content, so reading `content` alone reports
  // a parse failure and hides the stated reason — the caller then cannot tell "the model
  // declined" from "the model answered in a shape we could not read", and only the first is
  // something the user can act on. `length` is the quiet one: the content is present and reads
  // like a complete verdict.
  const choice = response.choices?.[0];
  if (choice?.message?.refusal) {
    throw new ProviderError(
      "openai",
      `The model declined to verify this image: ${choice.message.refusal}`,
    );
  }
  if (choice?.finish_reason === "content_filter") {
    throw new ProviderError(
      "openai",
      "OpenAI's content filter rejected this image verification. The input was rejected, not lost.",
    );
  }
  if (choice?.finish_reason === "length") {
    throw new ProviderError(
      "openai",
      "The model stopped at its output limit, so this verdict is truncated rather than complete.",
    );
  }

  const content = choice?.message?.content;
  const verdict = parseVerdict(content);
  return { raw: response, verdict };
}
