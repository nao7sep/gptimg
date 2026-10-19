/**
 * `gptimgsdk/testing`: a local stand-in for OpenAI, for a consumer's tests. Point the SDK at
 * it with the `baseURL` option and script each answer, so a test meets a refusal, a rate limit,
 * a missing image, an expired conversation or plain success without paying and without
 * reaching into the SDK. It speaks only the slice of OpenAI's API the SDK calls: images
 * (generate, edit), chat completions (vision) and responses (chat).
 *
 *   const openai = await startOpenAIDouble();
 *   const img = new GptImg({ apiKey: "sk-test", baseURL: openai.baseURL });
 *   openai.reply({ kind: "error", status: 429 });
 *   …
 *   await openai.close();
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/** One request the double received, its JSON body parsed (a multipart edit keeps only its size). */
export interface DoubleRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface DoubleUsage {
  input: number;
  output: number;
}

/**
 * One scripted answer, used by the next request. With none queued, every request succeeds:
 * images return one picture each, a chat turn returns text and one picture, a vision check
 * returns a passing verdict.
 */
export type DoubleReply =
  | {
      kind: "success";
      /** A chat turn's text. */
      text?: string;
      /** How many pictures to return; default 1 (a chat turn may return 0). */
      images?: number;
      /** The assistant's (or image endpoint's) token usage. */
      usage?: DoubleUsage;
      /** A chat turn's image-tool usage, as `tool_usage.image_gen`. */
      imageUsage?: DoubleUsage;
      /** A chat turn that stopped early, with this reason. */
      incomplete?: string;
    }
  | { kind: "verdict"; ok: boolean; score?: number; reasons?: string[] }
  /** The model's own refusal in a chat answer, with its stated reason. */
  | { kind: "refusal"; reason: string }
  /** A chat answer the content filter stopped. */
  | { kind: "contentFilter" }
  /** OpenAI's moderation declining an image request (400 `moderation_blocked`). */
  | { kind: "moderationBlocked"; message?: string }
  /** A chat turn whose `previousResponseId` OpenAI no longer holds. */
  | { kind: "previousResponseGone" }
  /** An answer that carries no picture where one was asked for. */
  | { kind: "noImage" }
  /** Any HTTP error, with OpenAI's error body; `insufficient_quota` with 429 is an exhausted quota. */
  | { kind: "error"; status: number; code?: string; message?: string; retryAfterSeconds?: number }
  /** Never answer, for a cancellation or timeout test. */
  | { kind: "hang" };

export interface OpenAIDouble {
  /** Pass as the SDK's `baseURL`. */
  readonly baseURL: string;
  /** Every request received, in order. */
  readonly requests: readonly DoubleRequest[];
  /** Queue answers for the next requests, in order. */
  reply(...replies: DoubleReply[]): void;
  close(): Promise<void>;
}

/** A 64×64 opaque PNG, the picture every successful image answer carries unless the test gives one. */
const PICTURE =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAn0lEQVRoge2SQQkAQRDDKqSiTnSErYh7hIFCBKSh4etpohuwAdUrsgv1LtEN2IDqFdmFepfoBmxA9YrsQr1LdAM2oHpFdqHeJboBG1C9IrtQ7xLdgA2oXpFdqHeJbsAGVK/ILtS7RDdgA6pXZBfqXaIbsAHVK7IL9S7RDdiA6hXZhXqX6AZsQPWK7EK9S3QDNqB6RXah3iW6ARtQveIfHo4LAR7afstBAAAAAElFTkSuQmCC";

const ROUTES = {
  "/v1/images/generations": "images",
  "/v1/images/edits": "images",
  "/v1/chat/completions": "vision",
  "/v1/responses": "chat",
} as const;

type Route = (typeof ROUTES)[keyof typeof ROUTES];

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks);
  if (String(req.headers["content-type"] ?? "").includes("application/json")) {
    try {
      return JSON.parse(raw.toString("utf8"));
    } catch {
      return raw.toString("utf8");
    }
  }
  return { bytes: raw.byteLength };
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "x-request-id": `req_double_${Date.now()}`, ...headers });
  res.end(JSON.stringify(body));
}

function errorBody(message: string, code: string | null, type = "invalid_request_error") {
  return { error: { message, type, param: null, code } };
}

function usageOf(usage: DoubleUsage | undefined, fallback: DoubleUsage) {
  const u = usage ?? fallback;
  return { input_tokens: u.input, output_tokens: u.output, total_tokens: u.input + u.output };
}

export async function startOpenAIDouble(options: { picture?: Uint8Array } = {}): Promise<OpenAIDouble> {
  const picture = options.picture ? Buffer.from(options.picture).toString("base64") : PICTURE;
  const queue: DoubleReply[] = [];
  const requests: DoubleRequest[] = [];
  let responses = 0;

  const answer = (route: Route, body: Record<string, unknown>, reply: DoubleReply, res: ServerResponse): void => {
    if (reply.kind === "hang") return;
    if (reply.kind === "error") {
      const headers: Record<string, string> = reply.retryAfterSeconds !== undefined ? { "retry-after": String(reply.retryAfterSeconds) } : {};
      const type = reply.code === "insufficient_quota" ? "insufficient_quota" : "invalid_request_error";
      send(res, reply.status, errorBody(reply.message ?? `Double error ${reply.status}`, reply.code ?? null, type), headers);
      return;
    }
    if (reply.kind === "moderationBlocked") {
      send(res, 400, errorBody(reply.message ?? "Your request was rejected by the safety system.", "moderation_blocked"));
      return;
    }
    if (reply.kind === "previousResponseGone") {
      send(res, 400, errorBody(`Previous response with id '${String(body.previous_response_id)}' not found.`, "previous_response_not_found"));
      return;
    }
    if (route === "images") {
      const n = typeof body.n === "number" ? body.n : 1;
      const count = reply.kind === "noImage" ? 0 : reply.kind === "success" ? (reply.images ?? n) : n;
      const data = Array.from({ length: Math.max(count, reply.kind === "noImage" ? n : 0) }, (_, i) =>
        i < count ? { b64_json: picture } : { b64_json: null },
      );
      const usage = reply.kind === "success" ? reply.usage : undefined;
      send(res, 200, { created: Math.floor(Date.now() / 1000), data, usage: usageOf(usage, { input: 50, output: 200 }) });
      return;
    }
    if (route === "vision") {
      const verdict = reply.kind === "verdict" ? { ok: reply.ok, score: reply.score ?? (reply.ok ? 1 : 0), reasons: reply.reasons ?? [] } : { ok: true, score: 1, reasons: [] };
      send(res, 200, {
        id: `chatcmpl_double_${++responses}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(verdict) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      });
      return;
    }
    // A chat turn: the Responses API.
    const id = `resp_double_${++responses}`;
    const base = { id, object: "response", created_at: Math.floor(Date.now() / 1000), model: body.model, previous_response_id: body.previous_response_id ?? null };
    if (reply.kind === "refusal") {
      send(res, 200, { ...base, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: reply.reason }] }], usage: usageOf(undefined, { input: 100, output: 10 }) });
      return;
    }
    if (reply.kind === "contentFilter") {
      send(res, 200, { ...base, status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [], usage: usageOf(undefined, { input: 100, output: 0 }) });
      return;
    }
    const success = reply.kind === "success" ? reply : { kind: "success" as const };
    const images = reply.kind === "noImage" ? 0 : (success.images ?? 1);
    const output: unknown[] = [];
    const text = success.text ?? "Here it is.";
    if (text) output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
    for (let i = 0; i < images; i++) output.push({ type: "image_generation_call", id: `ig_${id}_${i}`, status: "completed", result: picture });
    if (reply.kind === "noImage") output.push({ type: "image_generation_call", id: `ig_${id}_failed`, status: "failed", result: null });
    send(res, 200, {
      ...base,
      status: success.incomplete ? "incomplete" : "completed",
      incomplete_details: success.incomplete ? { reason: success.incomplete } : null,
      output,
      usage: usageOf(success.usage, { input: 1000, output: 100 }),
      tool_usage: { image_gen: usageOf(success.imageUsage, { input: images > 0 ? 80 : 0, output: images > 0 ? 200 : 0 }) },
    });
  };

  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      const body = await readBody(req);
      requests.push({ method: req.method ?? "", path, headers: req.headers, body });
      const route = (ROUTES as Record<string, Route | undefined>)[path];
      if (req.method !== "POST" || !route) {
        send(res, 404, errorBody(`Unknown endpoint ${req.method} ${path}`, null));
        return;
      }
      const reply = queue.shift() ?? { kind: "success" as const };
      answer(route, (body && typeof body === "object" ? body : {}) as Record<string, unknown>, reply, res);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    reply: (...replies) => {
      queue.push(...replies);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
