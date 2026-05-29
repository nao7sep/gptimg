import { Buffer } from "node:buffer";
import { LocalOpError, ProviderError } from "../../errors.js";
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

function modelSupportsOriginalDetail(model: string): boolean {
  return !/^gpt-5(?:\.\d+)?-(?:mini|nano)(?:-|$)/.test(model);
}

function assertSupportedVisionDetail(
  model: string,
  images: VisionProviderArgs["images"],
): void {
  if (!images.some((img) => img.detail === "original")) return;
  if (modelSupportsOriginalDetail(model)) return;
  throw new LocalOpError(
    "vision.detailUnsupported",
    `vision.detail=original is not supported by model ${model}; use low, high, or auto, or choose a model that supports original detail such as gpt-5.4`,
  );
}

function mimeFromFormat(format: string): string {
  if (format === "jpg") return "image/jpeg";
  return `image/${format}`;
}

function imageContentParts(images: VisionProviderArgs["images"]) {
  return images.map((img) => ({
    type: "image_url" as const,
    image_url: {
      url: `data:${mimeFromFormat(img.format)};base64,${Buffer.from(img.data).toString("base64")}`,
      ...(img.detail ? { detail: img.detail } : {}),
    },
  }));
}

function parseVerdict(raw: string | null | undefined): VisionVerdict {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, score: 0, reasons: ["Empty response from model"] };
  }
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.ok === "boolean" &&
      typeof parsed.score === "number" &&
      Array.isArray(parsed.reasons)
    ) {
      return {
        ok: parsed.ok,
        // The schema declares score as a number but does not bound it; clamp
        // so a stray out-of-range value can't propagate to callers.
        score: Math.max(0, Math.min(1, parsed.score)),
        reasons: parsed.reasons.map((r: unknown) => String(r)),
      };
    }
    return {
      ok: false,
      score: 0,
      reasons: ["Model response did not match the verdict schema"],
    };
  } catch {
    return {
      ok: false,
      score: 0,
      reasons: ["Failed to parse JSON from model response"],
    };
  }
}

export async function openaiVision(
  args: VisionProviderArgs,
): Promise<ProviderVisionResult> {
  const model = resolveModel(args.params.model, OPENAI_MODEL_DEFAULTS.vision);
  assertSupportedVisionDetail(model, args.images);
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
    choices?: Array<{ message?: { content?: string | null } }>;
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

  const content = response.choices?.[0]?.message?.content;
  const verdict = parseVerdict(content);
  return { raw: response, verdict };
}
