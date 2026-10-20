// The testing entry drives the real SDK through every answer a consumer's tests need.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GptImg } from "../../src/index.ts";
import { startOpenAIDouble, type OpenAIDouble } from "../../src/testing/index.ts";

let openai: OpenAIDouble;
let out: string;
let img: GptImg;

beforeEach(async () => {
  openai = await startOpenAIDouble();
  out = await mkdtemp(path.join(tmpdir(), "gptimg-double-"));
  img = new GptImg({ apiKey: "sk-double", baseURL: openai.baseURL });
});

afterEach(async () => {
  await openai.close();
  await rm(out, { recursive: true, force: true });
});

const fast = { network: { imageGenerate: { maxRetries: 1, retryIntervals: [1] } } };

describe("the OpenAI double", () => {
  it("answers a chat turn with text, a picture and both kinds of usage", async () => {
    openai.reply({ kind: "success", text: "A fox.", usage: { input: 11, output: 22 }, imageUsage: { input: 33, output: 44 } });
    const result = await img.chat({ message: "a fox", outDir: out, outName: "t1" });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.text).toBe("A fox.");
    expect(result.files).toHaveLength(1);
    expect(result.response).toMatchObject({ usage: { input_tokens: 11, output_tokens: 22 }, tool_usage: { image_gen: { input_tokens: 33 } } });
    expect(openai.requests[0]).toMatchObject({ path: "/v1/responses", headers: { authorization: "Bearer sk-double" } });
  });

  it("makes the chat resend its history when the stored conversation is gone", async () => {
    openai.reply({ kind: "previousResponseGone" }, { kind: "success" });
    const result = await img.chat({
      message: "again",
      history: [{ role: "user", text: "first" }, { role: "assistant", text: "ok" }],
      previousResponseId: "resp_old",
      outDir: out,
      outName: "t2",
    });
    expect(result).toMatchObject({ status: "completed", resumed: "resent" });
    expect(openai.requests).toHaveLength(2);
  });

  it("produces refusals: the model's own, the content filter and moderation", async () => {
    openai.reply({ kind: "refusal", reason: "Not this one." });
    expect(await img.chat({ message: "x", outDir: out, outName: "r1" })).toMatchObject({
      status: "refused",
      refusal: { code: "provider.refused", safeReason: "Not this one." },
    });
    openai.reply({ kind: "contentFilter" });
    expect(await img.chat({ message: "x", outDir: out, outName: "r2" })).toMatchObject({ status: "refused", refusal: { code: "provider.contentFiltered" } });
    openai.reply({ kind: "moderationBlocked" });
    expect(await img.generate({ prompt: "x", outDir: out, outName: "r3" })).toMatchObject({
      status: "refused",
      refusal: { code: "provider.moderationBlocked" },
    });
  });

  it("produces rate limits, an exhausted quota, a rejected key and a missing picture", async () => {
    openai.reply({ kind: "error", status: 429 }, { kind: "error", status: 429 });
    await expect(img.generate({ prompt: "x", outDir: out, outName: "e1", policy: fast })).rejects.toMatchObject({ code: "provider.rateLimited" });
    openai.reply({ kind: "error", status: 429, code: "insufficient_quota" });
    await expect(img.generate({ prompt: "x", outDir: out, outName: "e2", policy: fast })).rejects.toMatchObject({ code: "provider.quotaExhausted" });
    openai.reply({ kind: "error", status: 401, code: "invalid_api_key" });
    await expect(img.chat({ message: "x", outDir: out, outName: "e3" })).rejects.toMatchObject({ code: "provider.rejected", details: { status: 401 } });
    openai.reply({ kind: "noImage" });
    const missing = await img.generate({ prompt: "x", outDir: out, outName: "e4" });
    expect(missing).toMatchObject({ status: "completed", files: [], failures: [expect.objectContaining({ code: "provider.noImage" })] });
  });

  it("answers a vision check with the scripted verdict", async () => {
    openai.reply({ kind: "verdict", ok: false, reasons: ["two donuts"] });
    const picture = fileURLToPath(new URL("../fixtures/donut.png", import.meta.url));
    const result = await img.vision({ inputs: [picture], check: "one donut", outDir: out });
    expect(result).toMatchObject({ status: "completed", ok: false, reasons: ["two donuts"] });
  });

  it("can hang, so a test can cancel a call in flight", async () => {
    openai.reply({ kind: "hang" });
    const controller = new AbortController();
    const call = img.chat({ message: "slow", outDir: out, outName: "h1" }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(call).rejects.toMatchObject({ code: "cancelled" });
  });
});
