import { Buffer } from "node:buffer";
import { ProviderError } from "../../errors.js";
import { callWithRetry, isAbortError } from "../../network/retry.js";
import type { VisionVerdict } from "../../types.js";
import type { ProviderVisionResult, VisionProviderArgs } from "../types.js";
import { buildOpenAIClient, resolveModel } from "./client.js";

const DEFAULT_VISION_MODEL = "gpt-4o-mini";

const SYSTEM_PROMPT =
  "You are a strict image verification assistant. Given one or more images and a user-supplied criterion, decide whether the image(s) clearly satisfy the criterion. Return ok=true only when the criterion is clearly met. score is your confidence in [0, 1]. reasons is a list of concrete observations supporting your verdict (positive or negative).";

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

function imageContentParts(images: VisionProviderArgs["images"]) {
  return images.map((img) => ({
    type: "image_url" as const,
    image_url: {
      url: `data:${mimeFromFormat(img.format)};base64,${Buffer.from(img.data).toString("base64")}`,
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
        score: parsed.score,
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
  const client = buildOpenAIClient(args.profile);
  const model = resolveModel(
    args.params.model,
    args.profile.redacted.model,
    DEFAULT_VISION_MODEL,
  );

  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: args.check },
        ...imageContentParts(args.images),
      ],
    },
  ];

  const params: Record<string, unknown> = {
    ...args.params,
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
