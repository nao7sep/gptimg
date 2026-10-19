// A turn through the real SDK, against the SDK's local stand-in for OpenAI:
// the result shapes the app reads are the SDK's own, not hand-made.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOpenAIDouble, type OpenAIDouble } from "gptimgsdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRecords, type Records } from "../../src/main/records.ts";
import { readSession } from "../../src/main/sessions.ts";
import { TurnRunner } from "../../src/main/turns.ts";
import { builtInSettings } from "../../src/shared/settings.ts";
import { inProcessHost } from "../helpers/in-process-host.ts";

let openai: OpenAIDouble;
let root: string;
let records: Records;
let runner: TurnRunner;

beforeEach(async () => {
  openai = await startOpenAIDouble();
  const home = mkdtempSync(join(tmpdir(), "gptimg-turn-sdk-"));
  root = join(home, "chats");
  records = openRecords(join(home, "records.sqlite3"), join(home, "logs"), "launch", "test");
  runner = new TurnRunner({
    host: inProcessHost(),
    records,
    settings: () => ({ ...builtInSettings(), sessionsDir: root, "openai.endpoint": openai.baseURL }),
    apiKey: async () => "sk-test",
    app: { name: "GptImg", version: "test" },
    backup: () => {},
    releaseStaged: () => {},
    started: () => {},
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
});
