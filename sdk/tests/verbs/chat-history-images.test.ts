import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GptImg } from "../../src/gptimg.ts";
import { startOpenAIDouble, type OpenAIDouble } from "../../src/testing/index.ts";
import type { SdkEvent } from "../../src/types.ts";
import { done } from "../helpers/results.ts";

const fault = vi.hoisted(() => ({ file: "", error: undefined as Error | undefined }));
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return { ...real, readFile: (...args: Parameters<typeof real.readFile>) => {
    if (args[0] === fault.file && fault.error) return Promise.reject(fault.error);
    return real.readFile(...args);
  } };
});
let openai: OpenAIDouble;
let dir: string;
let sdk: GptImg;
beforeEach(async () => {
  openai = await startOpenAIDouble();
  dir = await mkdtemp(path.join(tmpdir(), "gptimg-chat-history-"));
  sdk = new GptImg({ apiKey: "offline", baseURL: openai.baseURL });
  fault.file = path.join(dir, "history.png");
  fault.error = undefined;
});
afterEach(async () => {
  await openai.close();
  await rm(dir, { recursive: true, force: true });
});
const args = () => ({ message: "again", outDir: dir, outName: "reply", history: [{ role: "assistant" as const, text: "earlier", images: [fault.file] }] });

it("skips a genuinely missing history image and reports its omission before dispatch", async () => {
  const events: SdkEvent[] = [];
  done(await sdk.chat(args(), { onEvent: (event) => events.push(event) }));
  expect(openai.requests).toHaveLength(1);
  expect(events.some((event) => event.event === "chat.historyImageSkipped")).toBe(true);
});

it.each([["EACCES", "fs.permissionDenied"], ["EIO", "fs.failed"]])("propagates %s before a paid history request is dispatched", async (errno, code) => {
  fault.error = Object.assign(new Error("history storage failed"), { code: errno });
  const events: SdkEvent[] = [];
  await expect(sdk.chat(args(), { onEvent: (event) => events.push(event) })).rejects.toMatchObject({ code, effect: "none", subject: fault.file });
  expect(openai.requests).toHaveLength(0);
  expect(events.some((event) => event.event === "chat.historyImageSkipped")).toBe(false);
});

it("propagates an undecodable history image before a paid request is dispatched", async () => {
  await writeFile(fault.file, "damaged image bytes");
  const events: SdkEvent[] = [];
  await expect(sdk.chat(args(), { onEvent: (event) => events.push(event) })).rejects.toMatchObject({ code: "image.undecodable", effect: "none", subject: fault.file });
  expect(openai.requests).toHaveLength(0);
  expect(events.some((event) => event.event === "chat.historyImageSkipped")).toBe(false);
});

it.each(["EACCES", "EIO", "decode"])("stops an expired-chain resend on %s without another provider dispatch", async (failure) => {
  openai.reply({ kind: "previousResponseGone" });
  if (failure === "decode") await writeFile(fault.file, "damaged image bytes");
  else fault.error = Object.assign(new Error("history storage failed"), { code: failure });
  await expect(sdk.chat({ ...args(), previousResponseId: "resp_expired" })).rejects.toMatchObject({
    code: failure === "EACCES" ? "fs.permissionDenied" : failure === "EIO" ? "fs.failed" : "image.undecodable",
  });
  expect(openai.requests).toHaveLength(1);
  expect(openai.requests[0]!.body).toMatchObject({ previous_response_id: "resp_expired" });
});
