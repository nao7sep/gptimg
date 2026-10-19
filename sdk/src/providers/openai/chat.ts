import { Buffer } from "node:buffer";
import { GptImgError } from "../../errors.ts";
import { maskDiagnosticCopy } from "../../log/mask.ts";
import { classifyRequestFailure, providerCode, safeReasonText } from "../../network/classify.ts";
import { callWithRetry } from "../../network/retry.ts";
import { RefusalSignal, refuse } from "../../refusal.ts";
import type { ChatHistoryTurn, ChatImage, ChatProviderArgs, ProviderChatResult } from "../types.ts";
import { buildOpenAIClient, clientHeaders, recordedResponse } from "./client.ts";
import { buildChatRequest } from "./request.ts";

interface ResponseItem {
  type?: string;
  id?: string;
  status?: string;
  result?: string | null;
  role?: string;
  content?: Array<{ type?: string; text?: string; refusal?: string }>;
}

interface ChatResponse {
  id?: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { code?: string; message?: string } | null;
  output?: ResponseItem[];
}

function mimeOf(format: string): string {
  return format === "jpg" || format === "jpeg" ? "image/jpeg" : `image/${format}`;
}

/** An image as a request part: its bytes as a data URL, or only its name for the records. */
function imagePart(image: ChatImage, withBytes: boolean): Record<string, unknown> {
  return {
    type: "input_image",
    image_url: withBytes ? `data:${mimeOf(image.format)};base64,${Buffer.from(image.data).toString("base64")}` : `[image ${image.name}]`,
    detail: "auto",
  };
}

function userMessage(text: string, images: readonly ChatImage[], withBytes: boolean): Record<string, unknown> {
  return {
    role: "user",
    content: [...(text.length > 0 ? [{ type: "input_text", text }] : []), ...images.map((image) => imagePart(image, withBytes))],
  };
}

/**
 * The earlier turns as input items. A user turn is a user message with its
 * images. An assistant turn is its reply, and its images follow as a user
 * message saying they were the assistant's: OpenAI accepts images only from
 * the user, and once its copy of the conversation is gone the images the
 * assistant made exist only in the caller's files.
 */
function historyItems(history: readonly ChatHistoryTurn[], withBytes: boolean): Record<string, unknown>[] {
  return history.flatMap((turn) => {
    if (turn.role === "user") return [userMessage(turn.text, turn.images, withBytes)];
    return [
      ...(turn.text.length > 0 ? [{ role: "assistant", content: turn.text }] : []),
      ...(turn.images.length > 0 ? [userMessage("(The images you produced in your previous turn.)", turn.images, withBytes)] : []),
    ];
  });
}

/**
 * OpenAI no longer holds the response a chained request names: it expired
 * (stored responses are kept for at least 30 days) or was never stored.
 * Nothing was processed, so the turn can be resent with its history.
 */
function previousResponseGone(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 404) return true;
  if (status !== 400) return false;
  if (providerCode(err) === "previous_response_not_found") return true;
  const message = (err as { error?: { message?: unknown } } | null)?.error?.message ?? (err as Error)?.message;
  return typeof message === "string" && /previous response/i.test(message) && /not found/i.test(message);
}

/**
 * One chat turn through the Responses API with the image-generation tool. A
 * mainline model reads the conversation, answers in words and generates or
 * edits images; with `previousResponseId` OpenAI's stored copy carries the
 * earlier turns, and when it is gone the same call resends them from the
 * caller's history. The response is stored (`store: true`) so the next turn
 * can chain from it.
 */
export async function openaiChat(args: ChatProviderArgs): Promise<ProviderChatResult> {
  const client = buildOpenAIClient(args.credentials);
  const { model, reasoning, instructions, tool } = args.params;
  const { primary, logger, signal } = args.network;
  logger?.addCredential(args.credentials.apiKey);

  const buildRequest = (history: readonly ChatHistoryTurn[] | null, withBytes: boolean): Record<string, unknown> =>
    buildChatRequest(model, {
      model,
      instructions,
      input: [...historyItems(history ?? [], withBytes), userMessage(args.message, args.images, withBytes)],
      tools: [{ type: "image_generation", ...tool }],
      store: true,
      ...(history === null && args.previousResponseId !== undefined && { previous_response_id: args.previousResponseId }),
    }, reasoning);

  // Each attempt is recorded with its request, image bytes replaced by the images' names.
  const send = async (history: readonly ChatHistoryTurn[] | null): Promise<ChatResponse> => {
    const params = buildRequest(history, true);
    const request = { headers: clientHeaders(client), body: buildRequest(history, false) };
    return (
      await callWithRetry(
        // A chat turn is paid like an image generation: resent only when provably unprocessed.
        { budgetName: "imageGenerate", budget: primary, signal, logger, request, response: recordedResponse },
        () => client.responses.create(params as never, { timeout: primary.timeout, maxRetries: 0, signal }).withResponse(),
      )
    ).data as ChatResponse;
  };
  const fail = (err: unknown): never => {
    throw classifyRequestFailure(maskDiagnosticCopy(err, [args.credentials.apiKey]), "imageGenerate", "OpenAI responses.create", [args.credentials.apiKey]);
  };

  let resumed: ProviderChatResult["resumed"] = null;
  let historyTurns = 0;
  let response: ChatResponse;
  if (args.previousResponseId !== undefined) {
    resumed = "chain";
    try {
      response = await send(null);
    } catch (err) {
      if (!previousResponseGone(err)) fail(err);
      await logger?.warn("request", "the previous response is gone; resending the conversation", {
        previousResponseId: args.previousResponseId,
      });
      resumed = "resent";
      const history = await args.loadHistory();
      historyTurns = history.length;
      try {
        response = await send(history);
      } catch (resendErr) {
        fail(resendErr);
      }
    }
  } else {
    const history = await args.loadHistory();
    historyTurns = history.length;
    try {
      response = await send(history);
    } catch (err) {
      fail(err);
    }
  }
  return readResponse(response!, { resumed, historyTurns, credentials: [args.credentials.apiKey] });
}

/** The turn's reply, images and outcome from a response; a refusal becomes a refused result carrying the paid answer. */
function readResponse(
  response: ChatResponse,
  ctx: { resumed: ProviderChatResult["resumed"]; historyTurns: number; credentials: readonly string[] },
): ProviderChatResult {
  const output = response.output ?? [];
  const attach = (signal: RefusalSignal): never => {
    signal.response = maskDiagnosticCopy(response, ctx.credentials) as Record<string, unknown>;
    throw signal;
  };
  try {
    const refusal = output.flatMap((item) => item.content ?? []).find((part) => part.type === "refusal");
    if (refusal) {
      refuse("provider.refused", "The assistant declined this request.", { safeReason: safeReasonText(refusal.refusal ?? "", ctx.credentials) });
    }
    if (response.status === "incomplete" && response.incomplete_details?.reason === "content_filter") {
      refuse("provider.contentFiltered", "OpenAI's content filter stopped this turn.");
    }
  } catch (err) {
    if (err instanceof RefusalSignal) attach(err);
    throw err;
  }
  if (response.status === "failed") {
    throw new GptImgError("provider.invalidResponse", `The turn failed at the provider: ${response.error?.message ?? "no reason given"}.`, {
      effect: "unknown",
      details: { ...(response.error?.code !== undefined && { providerCode: response.error.code }) },
    });
  }
  if (typeof response.id !== "string") {
    throw new GptImgError("provider.invalidResponse", "The provider's response has no id.", { effect: "unknown" });
  }
  const text = output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text!)
    .join("\n\n");
  const images = output
    .filter((item) => item.type === "image_generation_call")
    .map((item) =>
      item.status === "completed" && typeof item.result === "string" && item.result.length > 0
        ? { data: new Uint8Array(Buffer.from(item.result, "base64")) }
        : { data: null, error: `The image tool call ${item.id ?? ""} ended ${item.status ?? "without a status"}.` },
    );
  return {
    raw: response,
    images,
    text,
    responseId: response.id,
    resumed: ctx.resumed,
    historyTurns: ctx.historyTurns,
    incomplete: response.status === "incomplete" ? (response.incomplete_details?.reason ?? "unknown") : null,
  };
}
