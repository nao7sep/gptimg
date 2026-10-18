import { Buffer } from "node:buffer";
import { GptImgError } from "../../errors.ts";
import { classifyRequestFailure, safeReasonText } from "../../network/classify.ts";
import { RefusalSignal, refuse } from "../../refusal.ts";
import { maskDiagnosticCopy } from "../../log/mask.ts";
import { callWithRetry } from "../../network/retry.ts";
import type { VisionVerdict } from "../../types.ts";
import type { ProviderVisionResult, VisionProviderArgs } from "../types.ts";
import { buildOpenAIClient, clientHeaders, recordedResponse, resolveModel } from "./client.ts";
import { defaultModelFor } from "../../ai-models.ts";
import { OPENAI_VISION_SYSTEM_PROMPT } from "./defaults.ts";
import { resolveVisionReasoning } from "../../policy/model-check.ts";
import { buildVisionRequest } from "./request.ts";

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
 * Each image carries the `detail` the vision verb settled for the model, sent as
 * given; a model id with no row carries the caller's own value, or none.
 */
function imageContentParts(images: VisionProviderArgs["images"], withBytes: boolean) {
  return images.map((img) => ({
    type: "image_url" as const,
    image_url: {
      url: withBytes
        ? `data:${mimeFromFormat(img.format)};base64,${Buffer.from(img.data).toString("base64")}`
        : null,
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
    throw new GptImgError("provider.invalidResponse", "Vision model returned an empty response.", { effect: "unknown" });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new GptImgError("provider.invalidResponse", "Vision model response was not valid JSON.", {
      cause: err,
      effect: "unknown",
    });
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    typeof (parsed as { ok?: unknown }).ok === "boolean" &&
    typeof (parsed as { score?: unknown }).score === "number" &&
    Array.isArray((parsed as { reasons?: unknown }).reasons) &&
    (parsed as { reasons: unknown[] }).reasons.every((reason) => typeof reason === "string")
  ) {
    const v = parsed as { ok: boolean; score: number; reasons: string[] };
    return {
      ok: v.ok,
      // The schema declares score as a number but does not bound it; clamp
      // so a stray out-of-range value can't propagate to callers.
      score: Math.max(0, Math.min(1, v.score)),
      reasons: v.reasons,
    };
  }
  throw new GptImgError("provider.invalidResponse", "Vision model response did not match the verdict schema.", {
    effect: "unknown",
  });
}

interface ChatResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null; refusal?: string | null };
  }>;
}

/** The verdict a chat response carries, or the provider's stated reason it carries none. */
function verdictFrom(response: ChatResponse, credentials: readonly string[]): VisionVerdict {
  // The provider's own account of a result that is not what was asked for, read BEFORE the
  // content (ai-model-routing-conventions: *never invent a cause the provider gave you*). A
  // refusal arrives as a `refusal` string with null content, so reading `content` alone reports
  // a parse failure and hides the stated reason — the caller then cannot tell "the model
  // declined" from "the model answered in a shape we could not read", and only the first is
  // something the user can act on. `length` is the quiet one: the content is present and reads
  // like a complete verdict.
  const choice = response.choices?.[0];
  if (choice?.message?.refusal) {
    refuse("provider.refused", "The model declined to verify this image.", {
      safeReason: safeReasonText(choice.message.refusal, credentials),
    });
  }
  if (choice?.finish_reason === "content_filter") {
    refuse("provider.contentFiltered", "OpenAI's content filter rejected this image verification. The input was rejected, not lost.");
  }
  if (choice?.finish_reason === "length") {
    throw new GptImgError(
      "provider.truncated",
      "The model stopped at its output limit, so this verdict is truncated rather than complete.",
      { effect: "unknown" },
    );
  }

  return parseVerdict(choice?.message?.content);
}

export async function openaiVision(
  args: VisionProviderArgs,
): Promise<ProviderVisionResult> {
  const model = resolveModel(args.params.model, defaultModelFor("openai", "vision"));
  const client = buildOpenAIClient(args.profile);

  const { systemPrompt: paramsSystemPrompt, reasoning: paramsReasoning, ...passthroughParams } = args.params;
  const reasoning = resolveVisionReasoning(
    model,
    typeof paramsReasoning === "string" ? paramsReasoning : undefined,
  );
  const systemPrompt =
    typeof paramsSystemPrompt === "string" && paramsSystemPrompt.length > 0
      ? paramsSystemPrompt
      : OPENAI_VISION_SYSTEM_PROMPT;

  // The request as sent, or as recorded: the record nulls each image's data URL, since the
  // input file holds the image and the log's prepared-input line records how it was shrunk.
  const buildRequest = (withBytes: boolean) =>
    buildVisionRequest(model, {
      ...passthroughParams,
      model,
      messages: [
        { role: "system" as const, content: systemPrompt },
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: args.check },
            ...imageContentParts(args.images, withBytes),
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: VERDICT_SCHEMA,
      },
    }, reasoning);
  const params = buildRequest(true);
  const request = { headers: clientHeaders(client), body: buildRequest(false) };

  const { primary, logger, signal } = args.network;
  // Every record of this call, and any echo in an error, masks the key.
  logger?.addCredential(args.profile.apiKey);

  let response: ChatResponse;
  try {
    response = (
      await callWithRetry(
        { budgetName: "imageVision", budget: primary, signal, logger, request, response: recordedResponse },
        () =>
          client.chat.completions.create(params as never, {
            timeout: primary.timeout,
            maxRetries: 0,
            signal,
          }).withResponse(),
      )
    ).data as never;
  } catch (err) {
    throw classifyRequestFailure(maskDiagnosticCopy(err, [args.profile.apiKey]), "imageVision", "OpenAI chat.completions.create", [args.profile.apiKey]);
  }

  // A response the call cannot turn into a verdict is recorded with its request, so
  // the failure can be diagnosed (data-lifecycle-conventions, *Records*).
  let verdict: VisionVerdict;
  try {
    verdict = verdictFrom(response, [args.profile.apiKey]);
  } catch (err) {
    if (err instanceof RefusalSignal) {
      await logger?.warn("response", "vision response is a refusal", { request, response, code: err.refusal.code });
      throw err;
    }
    const diagnosticError = maskDiagnosticCopy(err, [args.profile.apiKey]);
    await logger?.warn("response", "vision response yielded no verdict", {
      request,
      response,
      error: {
        name: (diagnosticError as Error).name,
        code: (diagnosticError as { code?: unknown }).code ?? null,
        message: (diagnosticError as Error).message,
      },
    });
    throw diagnosticError;
  }
  return { raw: response, verdict };
}
