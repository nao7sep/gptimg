// The chat verb with a substituted provider: what it settles before the call,
// what it writes (each image with its chat record, or the record alone for a
// turn without images), and how it hands the caller's history to the provider.
import { readFile, readdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GptImg } from "../../src/gptimg.ts";
import type { ChatProviderArgs, Provider } from "../../src/providers/types.ts";
import { RefusalSignal } from "../../src/refusal.ts";
import { readSidecar } from "../../src/sidecar/read.ts";
import { done } from "../helpers/results.ts";

const provider = vi.hoisted(() => ({ generate: vi.fn(), edit: vi.fn(), vision: vi.fn(), chat: vi.fn() }));
vi.mock("../../src/providers/index.ts", () => ({
  getProvider: (): Provider => ({ name: "openai", ...provider }),
}));

describe("chat", () => {
  let tmp: string;
  let chatDir: string;
  let png: Buffer;
  let sdk: GptImg;

  beforeEach(async () => {
    for (const fn of Object.values(provider)) fn.mockReset();
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-chat-"));
    chatDir = path.join(tmp, "chat");
    png = await sharp({ create: { width: 64, height: 32, channels: 3, background: "#336699" } }).png().toBuffer();
    sdk = new GptImg({ apiKey: "sk-chat-test", app: { name: "GptImg", version: "1.0.0" } });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const answer = (over: Record<string, unknown> = {}) => ({
    raw: { id: "resp_2", output: [{ type: "image_generation_call", id: "ig_1", status: "completed", result: png.toString("base64") }], usage: { input_tokens: 9 } },
    images: [{ data: new Uint8Array(png) }],
    text: "Here you go.",
    responseId: "resp_2",
    resumed: "chain",
    historyTurns: 0,
    incomplete: null,
    ...over,
  });

  it("writes the turn's image with a chat record and returns the reply, the response id and the usage", async () => {
    provider.chat.mockResolvedValue(answer());
    const result = done(await sdk.chat({ message: "a lighthouse", previousResponseId: "resp_1", outDir: chatDir, outName: "turn-2" }));
    expect(result).toMatchObject({ text: "Here you go.", responseId: "resp_2", resumed: "chain", incomplete: null, recordPath: null, failures: [] });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.path).toBe(path.join(chatDir, "turn-2.png"));
    expect(result.response).toMatchObject({ usage: { input_tokens: 9 }, output: [{ result: null }] });

    const record = await readSidecar(path.join(chatDir, "turn-2.json"));
    expect(record).toMatchObject({
      formatVersion: 1,
      kind: "chat",
      writer: { name: "gptimgsdk", app: { name: "GptImg" } },
      request: {
        model: "gpt-5.6-terra",
        reasoning: "medium",
        tool: { model: "gpt-image-2.5-sunburst", moderation: "low" },
        message: "a lighthouse",
        images: [],
        previousResponseId: "resp_1",
        historyTurns: 0,
      },
      files: [{ index: 1, name: "turn-2.png", format: "png" }],
    });
    expect(await readFile(path.join(chatDir, "turn-2.json"), "utf8")).not.toContain(png.toString("base64"));
  });

  it("keeps a turn without images as its record alone", async () => {
    provider.chat.mockResolvedValue(answer({ images: [], text: "Which colour?", resumed: null, raw: { id: "resp_2", output: [], usage: { input_tokens: 4 } } }));
    const result = done(await sdk.chat({ message: "change it", outDir: chatDir, outName: "turn-3" }));
    expect(result).toMatchObject({ text: "Which colour?", files: [], recordPath: path.join(chatDir, "turn-3.json") });
    expect(await readdir(chatDir)).toEqual(["turn-3.json"]);
    expect(await readSidecar(path.join(chatDir, "turn-3.json"))).toMatchObject({ kind: "chat", files: [], response: { usage: { input_tokens: 4 } } });
  });

  it("sends no instructions of its own when the caller gives none", async () => {
    provider.chat.mockResolvedValue(answer());
    done(await sdk.chat({ message: "x", outDir: chatDir }));
    expect(provider.chat.mock.calls[0]![0].params.instructions).toBeUndefined();
  });

  it("settles the policy before the call: the assistant's effort, the tool's values and the instructions", async () => {
    provider.chat.mockResolvedValue(answer());
    done(await sdk.chat({
      message: "x",
      outDir: chatDir,
      policy: { chat: { model: "gpt-6-luna", reasoning: "low", instructions: "be terse", imageModel: "gpt-image-2.5-flare", quality: "high", size: "1536x1024" } },
    }));
    expect(provider.chat.mock.calls[0]![0].params).toEqual({
      model: "gpt-6-luna",
      reasoning: "low",
      instructions: "be terse",
      tool: { model: "gpt-image-2.5-flare", quality: "high", size: "1536x1024", moderation: "low" },
    });
    await expect(sdk.chat({ message: "x", outDir: chatDir, policy: { chat: { model: "gpt-6-astra", reasoning: "none" } } })).rejects.toMatchObject({
      code: "policy.invalid",
      details: { section: "chat" },
    });
    await expect(sdk.chat({ message: "x", outDir: chatDir, policy: { chat: { imageModel: "gpt-image-2", quality: "max" } } })).rejects.toMatchObject({
      code: "policy.invalid",
    });
    await expect(sdk.chat({ message: "x", outDir: chatDir, policy: { chat: { temperature: 1 } as never } })).rejects.toMatchObject({ code: "policy.invalid" });
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it("reads attachments before paying and passes the history fitted, recent images only, a missing one left out", async () => {
    const big = path.join(tmp, "big.png");
    await sharp({ create: { width: 3000, height: 1000, channels: 3, background: "#ff0000" } }).png().toFile(big);
    const turns = Array.from({ length: 10 }, (_, i) => ({ role: "assistant" as const, text: `turn ${i}`, images: [big] }));
    turns.push({ role: "assistant", text: "gone", images: [path.join(tmp, "deleted.png")] });
    provider.chat.mockImplementation(async (args: ChatProviderArgs) => {
      const loaded = await args.loadHistory();
      expect(loaded.slice(0, 3).every((t) => t.images.length === 0)).toBe(true);
      expect(loaded.slice(3, 10).every((t) => t.images.length === 1)).toBe(true);
      expect(loaded[10]!.images).toEqual([]);
      const meta = await sharp(Buffer.from(loaded[9]!.images[0]!.data)).metadata();
      expect(Math.max(meta.width, meta.height)).toBe(1536);
      expect(loaded[9]!.images[0]!.format).toBe("jpeg");
      expect(args.images[0]).toMatchObject({ name: "big.png", format: "png" });
      return answer({ resumed: null, historyTurns: loaded.length });
    });
    const result = done(await sdk.chat({ message: "again", images: [big], history: turns, outDir: chatDir }));
    expect(result.resumed).toBeNull();
    const record = await readSidecar(result.files[0]!.sidecarPath);
    expect(record.request).toMatchObject({ images: [{ name: "big.png", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }], previousResponseId: null, historyTurns: 11 });

    await expect(sdk.chat({ message: "x", images: [path.join(tmp, "nope.png")], outDir: chatDir })).rejects.toMatchObject({ code: "fs.notFound" });
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it("refuses relative paths, needs a key, and returns a provider's refusal with its paid answer", async () => {
    await expect(sdk.chat({ message: "x", outDir: chatDir, history: [{ role: "user", text: "a", images: ["rel.png"] }] })).rejects.toMatchObject({
      code: "args.invalid",
      details: { field: "history[0].images[0]" },
    });
    await expect(new GptImg().chat({ message: "x", outDir: chatDir })).rejects.toMatchObject({ code: "apiKey.missing" });
    provider.chat.mockImplementation(async () => {
      const signal = new RefusalSignal({ code: "provider.refused", message: "declined", safeReason: "no" });
      signal.response = { usage: { input_tokens: 3 } };
      throw signal;
    });
    await expect(sdk.chat({ message: "x", outDir: chatDir })).resolves.toMatchObject({
      status: "refused",
      refusal: { code: "provider.refused", safeReason: "no" },
      response: { usage: { input_tokens: 3 } },
    });
  });

  it("refuses a turn whose stem is taken before calling the provider", async () => {
    await writeFile(path.join(tmp, "taken.png"), "x");
    await expect(sdk.chat({ message: "x", outDir: tmp, outName: "taken" })).resolves.toMatchObject({ status: "refused", refusal: { code: "output.exists" } });
    expect(provider.chat).not.toHaveBeenCalled();
  });
});
