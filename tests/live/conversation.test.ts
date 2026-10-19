// The app's paid lane for the conversation: a request held back and then made,
// an image picked from the chat and edited, an exact size with an opaque
// background, a painted mask, and a streamed turn stopped mid-draft. Each turn
// asks for the cheapest output the app offers. Run by `npm run test:live` with
// OPENAI_API_KEY set; it prints what the image tool did, since that is the
// model's choice rather than something to assert.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { openRecords, type Records } from "../../src/main/records.ts";
import { readSession } from "../../src/main/sessions.ts";
import { TurnRunner } from "../../src/main/turns.ts";
import type { AssistantTurn } from "../../src/shared/session.ts";
import { builtInSettings } from "../../src/shared/settings.ts";
import { inProcessHost } from "../helpers/in-process-host.ts";

const key = process.env.OPENAI_API_KEY?.trim();

function setup(drafts = 0) {
  if (!key) throw new Error("OPENAI_API_KEY is not set: export it to run the live lane.");
  const home = mkdtempSync(join(tmpdir(), "gptimg-live-conversation-"));
  const root = join(home, "chats");
  const records = openRecords(join(home, "records.sqlite3"), join(home, "logs"), "live", "live");
  const seen: number[] = [];
  const runner = new TurnRunner({
    host: inProcessHost(),
    records,
    settings: () => ({ ...builtInSettings(), sessionsDir: root, "openai.drafts": drafts }),
    apiKey: async () => key,
    app: { name: "GptImg", version: "live" },
    backup: () => {},
    releaseStaged: () => {},
    started: () => {},
    draft: (_id, draft) => {
      if (draft) seen.push(draft.index);
    },
  });
  return { home, root, records, runner, seen };
}

/** What the image tool did in each successful call, oldest first: "generate", "edit", or none. */
function actions(records: Records): string[][] {
  const calls = records.query({ kind: "call" }).rows.filter((r) => r.title === "chat succeeded").reverse();
  return calls.map((row) => {
    const detail = records.detail({ source: row.source, id: row.id });
    const response = JSON.parse(detail?.blocks.find((b) => b.label === "response")?.text ?? "{}") as { body?: { output?: { type: string; action?: string }[] } };
    return (response.body?.output ?? []).filter((o) => o.type === "image_generation_call").map((o) => o.action ?? "?");
  });
}

const low = { size: "1024x1024", quality: "low" };

describe("a real conversation", () => {
  it("holds a request back when asked, makes it later, and edits an image picked from the chat", async () => {
    const { root, records, runner } = setup();
    const send = async (sessionId: string | null, text: string, references: string[] = []) => {
      const outcome = await runner.send({ requestId: text, sessionId, text, references, options: low });
      if (!outcome.ok) throw new Error(`"${text}" failed: ${JSON.stringify(outcome.failure)}`);
      return outcome.session;
    };
    const first = await send(null, "A small red circle on a white background. Make the image.");
    const id = first.id;
    await send(id, "Next I want a yellow star added to it, but not yet: don't make any image now, just say OK.");
    await send(id, "Also add a green square. Now make the image.");
    const firstImage = (first.doc.turns[1] as AssistantTurn).images[0]!;
    await send(id, "Sorry, I meant this one: edit it with the star and the square.", [firstImage]);
    const doc = await readSession(root, id);
    const replies = doc.turns.filter((t): t is AssistantTurn => t.role === "assistant");
    expect(replies.map((r) => r.images.length > 0)).toEqual([true, false, true, true]);
    expect(replies.slice(1).every((r) => r.resumed === "chain")).toBe(true);
    console.log("image tool actions per turn:", JSON.stringify(actions(records)));
    console.log("held-back reply:", JSON.stringify(replies[1]!.text));
    records.close();
  }, 900_000);

  it("makes an exact size with an opaque background, then changes only a painted area", async () => {
    const { root, records, runner } = setup();
    const made = await runner.send({
      requestId: "size",
      sessionId: null,
      text: "A calm blue sky over green grass. Make the image.",
      references: [],
      options: { size: "1280x720", quality: "low", background: "opaque" },
    });
    if (!made.ok) throw new Error(`size turn failed: ${JSON.stringify(made.failure)}`);
    const image = (made.session.doc.turns[1] as AssistantTurn).images[0]!;
    const meta = await sharp(join(made.session.dir, image)).metadata();
    expect([meta.width, meta.height]).toEqual([1280, 720]);
    // Transparent over the top left quarter: only the sky there may change.
    const mask = join(made.session.dir, "..", "mask.png");
    const opaque = await sharp({ create: { width: 1280, height: 720, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
      .composite([{ input: await sharp({ create: { width: 640, height: 360, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer(), left: 0, top: 0, blend: "dest-out" }])
      .png()
      .toBuffer();
    writeFileSync(mask, opaque);
    const masked = await runner.send({
      requestId: "mask",
      sessionId: made.session.id,
      text: "Put a small white bird in the painted area. Make the image.",
      references: [image],
      mask: { image, mask },
      options: { size: "1280x720", quality: "low" },
    });
    if (!masked.ok) throw new Error(`mask turn failed: ${JSON.stringify(masked.failure)}`);
    const doc = await readSession(root, made.session.id);
    expect(doc.turns[2]).toMatchObject({ role: "user", mask: expect.stringMatching(/^inputs\//) });
    expect((doc.turns[3] as AssistantTurn).images.length).toBeGreaterThan(0);
    console.log("mask turn actions:", JSON.stringify(actions(records)));
    records.close();
  }, 900_000);

  it("streams drafts, and a turn stopped after its first draft keeps the message for Try again", async () => {
    const { root, records, runner, seen } = setup(2);
    const sending = runner.send({ requestId: "draft", sessionId: null, text: "A lighthouse at dusk. Make the image.", references: [], options: low });
    const started = Date.now();
    while (seen.length === 0 && Date.now() - started < 240_000) await new Promise((r) => setTimeout(r, 200));
    expect(seen.length).toBeGreaterThan(0);
    const sessions = await import("node:fs/promises").then((fs) => fs.readdir(root));
    runner.cancel(sessions[0]!);
    const outcome = await sending;
    expect(outcome).toMatchObject({ ok: false, cancelled: true });
    const doc = await readSession(root, sessions[0]!);
    expect(doc.turns.map((t) => t.role)).toEqual(["user"]);
    console.log("drafts before stopping:", seen.length, "after", Math.round((Date.now() - started) / 1000), "s");
    records.close();
  }, 900_000);
});
