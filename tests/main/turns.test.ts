import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readSession } from "../../src/main/sessions.ts";
import { completed, request, setup } from "../helpers/turn-runner.ts";

describe("a turn", () => {
  it("saves the message first, then the reply with its images and tokens", async () => {
    const t = setup((call) => completed(call.args.outDir as string, "resp_1"));
    const outcome = await t.runner.send(request(null, "a red fox"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const doc = await readSession(t.root, outcome.session.id);
    expect(doc.title).toBe("a red fox");
    expect(doc.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(doc.turns[1]).toMatchObject({ images: ["img.png"], responseId: "resp_1", usage: { input: 12, output: 34 } });
    expect(t.started).toEqual(["r-a red fox"]);
    expect(t.calls[0]!.args).toMatchObject({ message: "a red fox", history: [], policy: { chat: { size: "1024x1024", quality: "low" } } });
    expect(t.calls[0]!.args.previousResponseId).toBeUndefined();
  });

  it("chains the next turn from the last reply and carries the history", async () => {
    let n = 0;
    const t = setup((call) => completed(call.args.outDir as string, `resp_${++n}`, `img${n}.png`));
    const first = await t.runner.send(request(null, "a fox"));
    if (!first.ok) throw new Error("first turn failed");
    await t.runner.send(request(first.session.id, "make it blue"));
    expect(t.calls[1]!.args.previousResponseId).toBe("resp_1");
    expect((t.calls[1]!.args.history as { role: string }[]).map((h) => h.role)).toEqual(["user", "assistant"]);
  });

  it("keeps the message and reports a refusal with the provider's reason, never retryable", async () => {
    const t = setup(() => ({
      kind: "result",
      result: { status: "refused", refusal: { code: "provider.moderationBlocked", message: "SDK English", safeReason: "Not allowed." }, response: { id: "resp_x" }, usage: null, responseId: "resp_x" },
    }));
    const outcome = await t.runner.send(request(null, "something"));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toEqual({ message: { key: "failure.moderationBlocked" }, reason: "Not allowed.", retryable: false });
    expect(outcome.session?.doc.turns.map((turn) => turn.role)).toEqual(["user"]);
  });

  it("retries an unanswered message as it was saved", async () => {
    let fail = true;
    const t = setup((call) => (fail ? { kind: "lost" } : completed(call.args.outDir as string, "resp_2")));
    const lost = await t.runner.send(request(null, "try me"));
    expect(lost.ok).toBe(false);
    fail = false;
    const id = (lost as { session: { id: string } }).session.id;
    const retried = await t.runner.retry(id);
    expect(retried.ok).toBe(true);
    expect(t.calls[1]!.args.message).toBe("try me");
  });

  it("stops before saving anything without a key", async () => {
    const t = setup(() => ({ kind: "lost" }), null);
    const outcome = await t.runner.send(request(null, "x"));
    expect(outcome).toMatchObject({ ok: false, session: null, failure: { message: { key: "failure.apiKeyMissing" } } });
    expect(t.calls).toHaveLength(0);
  });

  it("copies an attached file into the session and releases a staged one", async () => {
    const t = setup((call) => completed(call.args.outDir as string, "resp_1"));
    const source = join(mkdtempSync(join(tmpdir(), "gptimg-src-")), "ref.png");
    writeFileSync(source, "png");
    const outcome = await t.runner.send(request(null, "use this", [source]));
    if (!outcome.ok) throw new Error("turn failed");
    expect(outcome.session.doc.turns[0]!.images[0]).toMatch(/^inputs\/\d{8}-\d{6}-utc-ref\.png$/);
    expect(t.released).toEqual([source]);
  });

  it("cancels the running call", async () => {
    let release!: () => void;
    const t = setup((call) => new Promise((resolve) => {
      release = () => resolve(call.cancelled ? { kind: "error", error: { name: "GptImgError", code: "cancelled", kind: "cancelled", effect: "unknown", message: "x" } } : { kind: "lost" });
    }));
    const pending = t.runner.send(request(null, "slow"));
    await vi.waitFor(() => expect(readdirSync(t.root)).toHaveLength(1));
    const sessionId = readdirSync(t.root)[0]!;
    expect(t.runner.isRunning(sessionId)).toBe(true);
    t.runner.cancel(sessionId);
    release();
    const outcome = await pending;
    expect(outcome).toMatchObject({ ok: false, cancelled: true });
  });
});
