// A turn through the real SDK, against the SDK's local stand-in for OpenAI:
// the result shapes the app reads are the SDK's own, not hand-made.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOpenAIDouble, type OpenAIDouble } from "gptimgsdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRecords, type Records } from "../../src/main/records.ts";
import { readSession } from "../../src/main/sessions.ts";
import { CHAT_INSTRUCTIONS, TurnRunner } from "../../src/main/turns.ts";
import { builtInSettings } from "../../src/shared/settings.ts";
import { inProcessHost } from "../helpers/in-process-host.ts";

let openai: OpenAIDouble;
let root: string;
let records: Records;
let runner: TurnRunner;
let drafts: { sessionId: string; image: number | null }[];
let onDraft: () => void;
let released: string[];
let settings: Record<string, unknown>;

beforeEach(async () => {
  openai = await startOpenAIDouble();
  const home = mkdtempSync(join(tmpdir(), "gptimg-turn-sdk-"));
  root = join(home, "chats");
  drafts = [];
  onDraft = () => {};
  released = [];
  settings = {};
  records = openRecords(join(home, "records.sqlite3"), join(home, "logs"), "launch", "test");
  runner = new TurnRunner({
    host: inProcessHost(),
    records,
    settings: () => ({ ...builtInSettings(), sessionsDir: root, "openai.endpoint": openai.baseURL, ...settings }),
    apiKey: async () => "sk-test",
    app: { name: "GptImg", version: "test" },
    backup: () => {},
    releaseStaged: (path) => released.push(path),
    started: () => {},
    draft: (sessionId, draft) => { drafts.push({ sessionId, image: draft ? draft.image : null }); onDraft(); },
  });
});

afterEach(async () => {
  records.close();
  await openai.close();
});

const send = (sessionId: string | null, text: string, transparent = false) =>
  runner.send({ requestId: text, sessionId, text, references: [], options: { size: "1024x1024", quality: "low", ...(transparent && { transparent }) } });

describe("a turn through the real SDK", () => {
  it("saves the reply's text, image and both kinds of tokens, and records the call", async () => {
    openai.reply({ kind: "success", text: "**A fox.**", usage: { input: 10, output: 20 }, imageUsage: { input: 30, output: 40 } });
    const outcome = await send(null, "a fox");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const doc = await readSession(root, outcome.session.id);
    expect(doc.turns[1]).toMatchObject({ role: "assistant", text: "**A fox.**", usage: { input: 10, output: 20, imageInput: 30, imageOutput: 40 } });
    expect(doc.turns[1]!.images[0]).toMatch(/\.png$/);
    const calls = records.query({ kind: "call", chatId: doc.id! });
    expect(calls.rows[0]).toMatchObject({ title: "chat succeeded" });
    const appLines = records.query({ kind: "log", chatId: doc.id! }).rows.filter((r) => r.source === "app");
    expect(appLines.map((r) => r.title)).toEqual(["turn.replied", "turn.sent", "sessions.created"]);
    expect(openai.requests[0]!.body).toMatchObject({ instructions: CHAT_INSTRUCTIONS });
  });

  it("asks for a transparent PNG when the message does", async () => {
    await send(null, "a sticker", true);
    expect(openai.requests[0]!.body).toMatchObject({ tools: [{ type: "image_generation", background: "transparent", output_format: "png" }] });
  });

  it("chains the next turn and resends the conversation when OpenAI no longer holds it", async () => {
    const first = await send(null, "a fox");
    if (!first.ok) throw new Error("first turn failed");
    openai.reply({ kind: "previousResponseGone" }, { kind: "success" });
    const second = await send(first.session.id, "at night");
    expect(second).toMatchObject({ ok: true, session: { doc: { turns: [{}, {}, {}, { resumed: "resent" }] } } });
    expect((openai.requests[1]!.body as { previous_response_id?: string }).previous_response_id).toMatch(/^resp_double_/);
  });

  it("keeps the message and shows the provider's reason when the model refuses", async () => {
    openai.reply({ kind: "refusal", reason: "I can't make that." });
    const outcome = await send(null, "something");
    expect(outcome).toMatchObject({ ok: false, failure: { message: { key: "failure.refused" }, reason: "I can't make that.", retryable: false } });
  });

  it("names the key when OpenAI rejects it", async () => {
    openai.reply({ kind: "error", status: 401, code: "invalid_api_key" });
    expect(await send(null, "x")).toMatchObject({ ok: false, failure: { message: { key: "failure.keyRejected" } } });
  });

  it("asks for an opaque background, and still reads the transparency of turns saved before backgrounds", async () => {
    await runner.send({ requestId: "o", sessionId: null, text: "a card", references: [], options: { size: "1536x1024", quality: "low", background: "opaque" } });
    expect(openai.requests[0]!.body).toMatchObject({ tools: [{ background: "opaque", size: "1536x1024" }] });
    expect((openai.requests[0]!.body as { tools: Record<string, unknown>[] }).tools[0]!.output_format).toBeUndefined();
    await send(null, "a sticker", true);
    expect(openai.requests[1]!.body).toMatchObject({ tools: [{ background: "transparent", output_format: "png" }] });
  });

  it("shows drafts while the image is drawn and clears them when the turn settles; with drafts off it does not stream", async () => {
    const outcome = await send(null, "a fox");
    if (!outcome.ok) throw new Error("turn failed");
    expect(openai.requests[0]!.body).toMatchObject({ stream: true, tools: [{ partial_images: 2 }] });
    expect(drafts.map((d) => d.image)).toEqual([0, 0, null]);
    expect(drafts.every((d) => d.sessionId === outcome.session.id)).toBe(true);
    settings = { "openai.drafts": 0 };
    await send(outcome.session.id, "at night");
    expect((openai.requests[1]!.body as { stream?: boolean }).stream).toBeUndefined();
  });

  it("tells blocked images and missing images apart from images that could not be saved", async () => {
    openai.reply({ kind: "success", images: 1, blockedImages: 2 }, { kind: "noImage" });
    const first = await send(null, "three portraits");
    if (!first.ok) throw new Error("turn failed");
    expect(first.session.doc.turns[1]).toMatchObject({ images: [expect.any(String)], failedImages: 0, blockedImages: 2 });
    const second = await send(first.session.id, "one more");
    if (!second.ok) throw new Error("turn failed");
    expect(second.session.doc.turns[3]).toMatchObject({ images: [], failedImages: 0, missingImages: 1 });
  });

  it("saves a painted mask into the chat and sends it with its image first", async () => {
    const sharp = (await import("sharp")).default;
    const staged = mkdtempSync(join(tmpdir(), "gptimg-staged-"));
    const other = join(staged, "other.png");
    const photo = join(staged, "photo.png");
    const mask = join(staged, "mask-1.png");
    writeFileSync(other, await sharp({ create: { width: 32, height: 32, channels: 3, background: "#fff" } }).png().toBuffer());
    writeFileSync(photo, await sharp({ create: { width: 64, height: 48, channels: 3, background: "#369" } }).png().toBuffer());
    writeFileSync(mask, await sharp({ create: { width: 64, height: 48, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer());
    const outcome = await runner.send({
      requestId: "m",
      sessionId: null,
      text: "a hat on him",
      references: [other, photo],
      mask: { image: photo, mask },
      options: { size: "auto", quality: "low" },
    });
    if (!outcome.ok) throw new Error(`turn failed: ${JSON.stringify(outcome)}`);
    const turn = outcome.session.doc.turns[0]!;
    expect(turn).toMatchObject({ role: "user", images: [expect.stringMatching(/^inputs\/.*photo\.png$/), expect.stringMatching(/other\.png$/)], mask: expect.stringMatching(/^inputs\/.*mask-1\.png$/) });
    expect(released).toContain(mask);
    const body = openai.requests[0]!.body as { tools: { input_image_mask?: { image_url: string } }[] };
    expect(body.tools[0]!.input_image_mask!.image_url).toMatch(/^data:image\/png;base64,/);
  });

  it("keeps the message when a streaming turn is cancelled, clears the draft, and lets the next message leave it out", async () => {
    const first = await send(null, "a fox");
    if (!first.ok) throw new Error("turn failed");
    const id = first.session.id;
    openai.reply({ kind: "streamStalled" });
    const drawing = new Promise<void>((resolve) => { onDraft = () => { if (drafts.filter((d) => d.image === 0).length === 3) resolve(); }; });
    const cancelled = send(id, "add a hat");
    await drawing;
    runner.cancel(id);
    expect(await cancelled).toMatchObject({ ok: false, cancelled: true });
    expect(drafts.at(-1)).toEqual({ sessionId: id, image: null });
    const doc = await readSession(root, id);
    expect(doc.turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
    // The next message chains from the last reply: the cancelled message was never part of OpenAI's conversation.
    const next = await send(id, "a scarf instead");
    expect(next.ok).toBe(true);
    const body = openai.requests.at(-1)!.body as { previous_response_id?: string; input: { content: { text?: string }[] }[] };
    expect(body.previous_response_id).toBe((doc.turns[1] as { responseId: string }).responseId);
    expect(body.input.map((item) => item.content.map((c) => c.text).join(""))).toEqual(["a scarf instead"]);
  });

  it("fails a turn whose stream drops, without resending, and Try again sends it once more", async () => {
    openai.reply({ kind: "streamDropped", afterDrafts: 1 });
    const failed = await send(null, "a fox");
    expect(failed).toMatchObject({ ok: false, cancelled: false, failure: { retryable: true } });
    expect(openai.requests).toHaveLength(1);
    if (!failed.session) throw new Error("no session");
    const retried = await runner.retry(failed.session.id);
    expect(retried).toMatchObject({ ok: true, session: { doc: { turns: [{ role: "user" }, { role: "assistant" }] } } });
    expect(openai.requests).toHaveLength(2);
  });
});
