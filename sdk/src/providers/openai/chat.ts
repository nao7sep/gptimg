import { Buffer } from "node:buffer";
import { GptImgError } from "../../errors.ts";
import { maskDiagnosticCopy } from "../../events/mask.ts";
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
  error?: { code?: string; message?: string; moderation_details?: { categories?: string[]; moderation_stage?: string } } | null;
  role?: string;
  content?: Array<{ type?: string; text?: string; refusal?: string }>;
}

/** The streamed events a chat turn reads; the rest are passed over. */
interface StreamEvent {
  type?: string;
  item_id?: string;
  partial_image_index?: number;
  partial_image_b64?: string;
  response?: ChatResponse;
  code?: string;
  message?: string;
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
 * OpenAI answers 400 with `previous_response_not_found` (observed
 * 2026-10-19); the 404 and the message are kept as fallbacks. Nothing was
 * processed, so the turn can be resent with its history.
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
      tools: [{ type: "image_generation", ...tool, ...(args.mask && { input_image_mask: { image_url: imagePart(args.mask, withBytes).image_url } }) }],
      store: true,
      ...(history === null && args.previousResponseId !== undefined && { previous_response_id: args.previousResponseId }),
    }, reasoning);

  const streaming = args.onPartialImage !== undefined;

  // Each attempt is recorded with its request, image bytes replaced by the images' names.
  const send = async (history: readonly ChatHistoryTurn[] | null): Promise<ChatResponse> => {
    const params = { ...buildRequest(history, true), ...(streaming && { stream: true }) };
    const request = { headers: clientHeaders(client), body: { ...buildRequest(history, false), ...(streaming && { stream: true }) } };
    return (
      await callWithRetry(
        // A chat turn is paid like an image generation: resent only when provably unprocessed.
        { budgetName: "imageGenerate", budget: primary, signal, logger, request, response: recordedResponse },
        () =>
          streaming
            ? streamed(params)
            : client.responses.create(params as never, { timeout: primary.timeout, maxRetries: 0, signal }).withResponse(),
      )
    ).data as ChatResponse;
  };

  /**
   * The same call streamed, so partial images arrive while the turn runs. It
   * settles on the stream's final response, as the plain call does. A stream
   * that goes quiet for the attempt's timeout is a timeout, and one that ends
   * without a final response is a dropped connection: the request was sent, so
   * neither is resent.
   */
  const streamed = async (params: Record<string, unknown>) => {
    const idle = new AbortController();
    const linked = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => idle.abort(Object.assign(new Error(`The response stream was silent for ${primary.timeout} ms.`), { name: "TimeoutError" })),
        primary.timeout,
      );
    };
    arm();
    try {
      const { data: stream, response, request_id } = await client.responses
        .create(params as never, { timeout: primary.timeout, maxRetries: 0, signal: linked })
        .withResponse();
      let final: ChatResponse | undefined;
      for await (const event of stream as unknown as AsyncIterable<StreamEvent>) {
        arm();
        if (event.type === "response.image_generation_call.partial_image" && typeof event.partial_image_b64 === "string") {
          args.onPartialImage?.({
            callId: event.item_id ?? "",
            index: event.partial_image_index ?? 0,
            data: new Uint8Array(Buffer.from(event.partial_image_b64, "base64")),
          });
        } else if (event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.failed") {
          final = event.response;
        } else if (event.type === "error") {
          throw new GptImgError("provider.invalidResponse", `The response stream reported an error: ${event.message ?? "no reason given"}.`, {
            effect: "unknown",
            details: { ...(event.code && { providerCode: event.code }) },
          });
        }
      }
      if (!final) {
        throw Object.assign(new Error("The response stream ended before the response completed."), { code: "ECONNRESET" });
      }
      return { data: final, response, request_id };
    } catch (err) {
      // The silence timer's abort surfaces as the stream's abort; report it as the timeout it was.
      if (idle.signal.aborted && !signal?.aborted) throw idle.signal.reason;
      throw err;
    } finally {
      clearTimeout(timer);
    }
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
      logger?.emit("warn", "request", { event: "chat.resend", previousResponseId: args.previousResponseId });
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
    .map((item) => {
      if (item.status === "completed" && typeof item.result === "string" && item.result.length > 0) {
        return { data: new Uint8Array(Buffer.from(item.result, "base64")) };
      }
      // The image tool's call fails on its own while the turn completes: a moderation block is the provider declining, not an image gone missing.
      if (item.error?.code === "moderation_blocked") {
        const details = item.error.moderation_details;
        const categories = details?.categories?.length ? details.categories.join(", ") : null;
        const stage = details?.moderation_stage ? `, judged on the ${details.moderation_stage}` : "";
        return {
          data: null,
          code: "provider.moderationBlocked" as const,
          error: `The provider's moderation blocked image tool call ${item.id ?? ""}${categories ? ` (${categories}${stage})` : ""}.`,
        };
      }
      return { data: null, error: `The image tool call ${item.id ?? ""} ended ${item.status ?? "without a status"}${item.error?.message ? `: ${item.error.message}` : ""}.` };
    });
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
