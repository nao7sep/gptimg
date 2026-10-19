// The chat adapter against a mocked OpenAI client: the request it builds, how
// it carries a conversation (OpenAI's stored copy, or the caller's history when
// that copy is gone), and how it reads replies, images, refusals and early stops.
import { Buffer } from "node:buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, type Logger } from "../../src/events/index.ts";
import { NETWORK_DEFAULTS } from "../../src/network/defaults.ts";
import { openaiChat } from "../../src/providers/openai/chat.ts";
import type { ChatHistoryTurn, ChatProviderArgs } from "../../src/providers/types.ts";
import type { SdkEvent } from "../../src/types.ts";

const openaiMock = vi.hoisted(() => ({ create: vi.fn() }));

function apiPromise(call: (...args: unknown[]) => unknown) {
  return (...args: unknown[]) => {
    const body = Promise.resolve().then(() => call(...args));
    return Object.assign(body, {
      withResponse: async () => ({
        data: await body,
        response: new Response(null, { status: 200, headers: { "x-request-id": "req_test" } }),
        request_id: "req_test",
      }),
    });
  };
}

vi.mock("openai", () => ({
  default: class OpenAI {
    readonly apiKey: string;
    constructor(opts: { apiKey: string }) {
      this.apiKey = opts.apiKey;
    }
    readonly responses = { create: apiPromise(openaiMock.create) };
  },
}));

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const B64 = Buffer.from(PNG).toString("base64");

function reply(extra: Record<string, unknown> = {}) {
  return {
    id: "resp_2",
    status: "completed",
    output: [
      { type: "reasoning", id: "rs_1" },
      { type: "image_generation_call", id: "ig_1", status: "completed", result: B64, revised_prompt: "a cat" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Here is your cat." }] },
    ],
    usage: { input_tokens: 120, output_tokens: 40 },
    ...extra,
  };
}

function apiError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(`${status} ${message}`), { status, error: { code, message } });
}

const history: ChatHistoryTurn[] = [
  { role: "user", text: "draw a cat", images: [] },
  { role: "assistant", text: "Here it is.", images: [{ name: "turn-1.png", data: PNG, format: "png" }] },
];

describe("openaiChat", () => {
  let events: SdkEvent[];
  let logger: Logger;
  let loadHistory: ReturnType<typeof vi.fn<() => Promise<ChatHistoryTurn[]>>>;

  beforeEach(async () => {
    openaiMock.create.mockReset();
    events = [];
    logger = createLogger("chat", { onEvent: (e) => events.push(e) });
    loadHistory = vi.fn<() => Promise<ChatHistoryTurn[]>>(async () => history);
  });

  const call = (over: Partial<ChatProviderArgs> = {}) =>
    openaiChat({
      message: "make it orange",
      images: [{ name: "ref.png", data: PNG, format: "png" }],
      loadHistory,
      params: { model: "gpt-5.6-terra", reasoning: "medium", instructions: "be brief", tool: { model: "gpt-image-2.5-sunburst", moderation: "low" } },
      credentials: { apiKey: "sk-chat-secret" },
      network: { primary: { ...NETWORK_DEFAULTS.imageGenerate, retryIntervals: [] }, download: NETWORK_DEFAULTS.imageDownload, logger },
      ...over,
    });

  it("chains from the previous response, sending only the new turn with the image tool", async () => {
    openaiMock.create.mockResolvedValue(reply());
    const result = await call({ previousResponseId: "resp_1" });
    const [body] = openaiMock.create.mock.calls[0]!;
    expect(body).toMatchObject({
      model: "gpt-5.6-terra",
      instructions: "be brief",
      previous_response_id: "resp_1",
      store: true,
      reasoning: { effort: "medium" },
      tools: [{ type: "image_generation", model: "gpt-image-2.5-sunburst", moderation: "low" }],
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "make it orange" },
            { type: "input_image", image_url: `data:image/png;base64,${B64}`, detail: "auto" },
          ],
        },
      ],
    });
    expect(loadHistory).not.toHaveBeenCalled();
    expect(result).toMatchObject({ text: "Here is your cat.", responseId: "resp_2", resumed: "chain", historyTurns: 0, incomplete: null });
    expect(result.images).toEqual([{ data: PNG }]);
  });

  it("resends the conversation when OpenAI no longer holds the previous response", async () => {
    openaiMock.create
      .mockRejectedValueOnce(apiError(400, "previous_response_not_found", "Previous response with id 'resp_1' not found."))
      .mockResolvedValueOnce(reply());
    const result = await call({ previousResponseId: "resp_1" });
    expect(openaiMock.create).toHaveBeenCalledTimes(2);
    const [resent] = openaiMock.create.mock.calls[1]!;
    expect(resent).not.toHaveProperty("previous_response_id");
    expect(resent.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "draw a cat" }] },
      { role: "assistant", content: "Here it is." },
      {
        role: "user",
        content: [
          { type: "input_text", text: "(The images you produced in your previous turn.)" },
          { type: "input_image", image_url: `data:image/png;base64,${B64}`, detail: "auto" },
        ],
      },
      expect.objectContaining({ role: "user" }),
    ]);
    expect(result).toMatchObject({ resumed: "resent", historyTurns: 2 });
    expect(events.some((e) => e.event === "chat.resend")).toBe(true);
  });

  it("sends the history when there is no previous response", async () => {
    openaiMock.create.mockResolvedValue(reply());
    const result = await call();
    expect(openaiMock.create.mock.calls[0]![0].input).toHaveLength(4);
    expect(result).toMatchObject({ resumed: null, historyTurns: 2 });
  });

  it("records each attempt's request with image names instead of bytes, and the key masked", async () => {
    openaiMock.create.mockResolvedValue(reply());
    await call({ previousResponseId: "resp_1" });
    const text = JSON.stringify(events);
    expect(text).not.toContain(B64);
    expect(text).toContain("[image ref.png]");
    expect(text).not.toContain("sk-chat-secret");
  });

  it("keeps a failed image call as a missing image and the reply text", async () => {
    openaiMock.create.mockResolvedValue(
      reply({ output: [{ type: "image_generation_call", id: "ig_9", status: "failed" }, { type: "message", content: [{ type: "output_text", text: "Sorry." }] }] }),
    );
    const result = await call();
    expect(result.images).toEqual([{ data: null, error: expect.stringContaining("ig_9") }]);
    expect(result.text).toBe("Sorry.");
  });

  it("returns a text-only turn with no images", async () => {
    openaiMock.create.mockResolvedValue(reply({ output: [{ type: "message", content: [{ type: "output_text", text: "Which style?" }] }] }));
    expect(await call()).toMatchObject({ text: "Which style?", images: [] });
  });

  it("reports an early stop and keeps what arrived", async () => {
    openaiMock.create.mockResolvedValue(reply({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }));
    expect(await call()).toMatchObject({ incomplete: "max_output_tokens", images: [{ data: PNG }] });
  });

  it("turns a refusal and a content filter into refusals carrying the paid answer and its usage", async () => {
    openaiMock.create.mockResolvedValueOnce(
      reply({ output: [{ type: "message", content: [{ type: "refusal", refusal: "I can't help with that." }] }] }),
    );
    await expect(call()).rejects.toMatchObject({
      refusal: { code: "provider.refused", safeReason: "I can't help with that." },
      response: { usage: { input_tokens: 120 } },
    });
    openaiMock.create.mockResolvedValueOnce(reply({ status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] }));
    await expect(call()).rejects.toMatchObject({ refusal: { code: "provider.contentFiltered" }, response: { usage: { input_tokens: 120 } } });
  });

  it("classifies other failures, including a moderation block, without resending", async () => {
    openaiMock.create.mockRejectedValueOnce(apiError(400, "moderation_blocked", "Your request was rejected by the safety system."));
    await expect(call({ previousResponseId: "resp_1" })).rejects.toMatchObject({ refusal: { code: "provider.moderationBlocked" } });
    openaiMock.create.mockRejectedValueOnce(apiError(400, "invalid_value", "Invalid size."));
    await expect(call({ previousResponseId: "resp_1" })).rejects.toMatchObject({ code: "provider.rejected" });
    expect(loadHistory).not.toHaveBeenCalled();
  });
});
