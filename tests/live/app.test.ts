// The app's own paid lane: a chat turn and a follow-up through the turn runner
// and the real SDK against OpenAI, at the cheapest output the app offers (a
// low-quality square). Run by `npm run test:full` with OPENAI_API_KEY set.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openRecords } from "../../src/main/records.ts";
import { readSession } from "../../src/main/sessions.ts";
import { TurnRunner } from "../../src/main/turns.ts";
import { builtInSettings } from "../../src/shared/settings.ts";
import { chatClients } from "../../src/main/sdk.ts";

const key = process.env.OPENAI_API_KEY?.trim();

describe("a real chat", () => {
  it("makes an image, then edits it through OpenAI's stored conversation", async () => {
    if (!key) throw new Error("OPENAI_API_KEY is not set: export it to run the live lane.");
    const home = mkdtempSync(join(tmpdir(), "gptimg-live-app-"));
    const root = join(home, "chats");
    const records = openRecords(join(home, "records.sqlite3"), join(home, "logs"), "live", "live");
    const runner = new TurnRunner({
      sdk: chatClients({ name: "GptImg", version: "live" }),
      records,
      settings: () => ({ ...builtInSettings(), sessionsDir: root }),
      apiKey: async () => key,
      backup: () => {},
      releaseStaged: () => {},
      saved: () => {},
      started: () => {},
    });
    const options = { size: "1024x1024", quality: "low" };
    const first = await runner.send({ requestId: "1", sessionId: null, text: "A small red circle on white. Make the image.", references: [], options });
    if (!first.ok) throw new Error(`first turn failed: ${JSON.stringify(first.failure)}`);
    const second = await runner.send({ requestId: "2", sessionId: first.session.id, text: "Make the circle blue. Make the image.", references: [], options });
    if (!second.ok) throw new Error(`second turn failed: ${JSON.stringify(second.failure)}`);
    const doc = await readSession(root, second.session.id);
    const replies = doc.turns.filter((t) => t.role === "assistant");
    expect(replies).toHaveLength(2);
    expect(replies.every((t) => t.role === "assistant" && t.images.length >= 1 && (t.usage?.input ?? 0) > 0)).toBe(true);
    expect(replies[1]).toMatchObject({ resumed: "chain" });
    expect(records.query({ kind: "call" }).rows.filter((r) => r.title === "chat succeeded")).toHaveLength(2);
    records.close();
  });
});
