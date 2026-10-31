import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as chats from "../../src/main/chats.ts";
import { createChat, readChat, writeChat } from "../../src/main/chats.ts";
import { cancelled, completed, dropped, request, setup } from "../helpers/turn-runner.ts";

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function emptyChat(root: string): Promise<string> {
  const { id, doc } = await createChat(root, new Date("2026-10-23T00:00:00.000Z"), "existing");
  await writeChat(root, id, doc);
  return id;
}

afterEach(() => { vi.restoreAllMocks(); });

describe("a turn", () => {
  it("saves the message first, then the reply with its images and tokens", async () => {
    const t = setup((call) => completed(call.args.outDir as string, "resp_1"));
    const outcome = await t.runner.send(request(null, "a red fox"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const doc = await readChat(t.root, outcome.chat.id);
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
    await t.runner.send(request(first.chat.id, "make it blue"));
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
    expect(outcome.chat?.doc.turns.map((turn) => turn.role)).toEqual(["user"]);
  });

  it("retries an unanswered message as it was saved", async () => {
    let fail = true;
    const t = setup((call) => (fail ? dropped : completed(call.args.outDir as string, "resp_2")));
    const lost = await t.runner.send(request(null, "try me"));
    expect(lost.ok).toBe(false);
    fail = false;
    const id = (lost as { chat: { id: string } }).chat.id;
    const retried = await t.runner.retry(id);
    expect(retried.ok).toBe(true);
    expect(t.calls[1]!.args.message).toBe("try me");
  });

  it("stops before saving anything without a key", async () => {
    const t = setup(() => dropped, null);
    const outcome = await t.runner.send(request(null, "x"));
    expect(outcome).toMatchObject({ ok: false, chat: null, failure: { message: { key: "failure.apiKeyMissing" } } });
    expect(t.calls).toHaveLength(0);
  });

  it("copies an attached file into the chat and releases a staged one", async () => {
    const t = setup((call) => completed(call.args.outDir as string, "resp_1"));
    const source = join(mkdtempSync(join(tmpdir(), "gptimg-src-")), "ref.png");
    writeFileSync(source, "png");
    const outcome = await t.runner.send(request(null, "use this", [source]));
    if (!outcome.ok) throw new Error("turn failed");
    expect(outcome.chat.doc.turns[0]!.images[0]).toMatch(/^inputs\/\d{8}-\d{6}-utc-ref\.png$/);
    expect(t.released).toEqual([source]);
  });

  it("cancels the running call", async () => {
    let release!: () => void;
    const calling = gate<void>();
    const t = setup((call) => new Promise((resolve) => {
      release = () => resolve(call.cancelled ? cancelled : dropped);
      calling.resolve();
    }));
    const pending = t.runner.send(request(null, "slow"));
    await calling.promise;
    const chatFolder = readdirSync(t.root)[0]!;
    expect(t.runner.isRunning(chatFolder)).toBe(true);
    t.runner.cancel(chatFolder);
    release();
    const outcome = await pending;
    expect(outcome).toMatchObject({ ok: false, cancelled: true });
  });

  it("cancels every running turn and settles only once each has recorded its outcome", async () => {
    const calling = gate<void>();
    const provider = gate<void>();
    const t = setup(async (call) => {
      calling.resolve();
      await provider.promise;
      return call.cancelled ? cancelled : dropped;
    });
    const pending = t.runner.send(request(null, "quit while paid"));
    await calling.promise;
    let settled = false;
    const cancelling = t.runner.cancelAll().then(() => { settled = true; });
    expect(t.calls[0]!.cancelled).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(t.turnsRecorded).toEqual([]);
    provider.resolve();
    await cancelling;
    expect(t.turnsRecorded).toEqual([expect.objectContaining({ status: "cancelled" })]);
    await expect(pending).resolves.toMatchObject({ ok: false, cancelled: true });
    expect(t.runner.busy).toBe(false);
  });

  it("reserves an existing chat before a delayed key lookup so a second send cannot enter", async () => {
    const t = setup((call) => completed(call.args.outDir as string, "resp_one"));
    const id = await emptyChat(t.root);
    const key = gate<string | null>();
    const apiKey = vi.fn(() => key.promise);
    t.runner.deps.apiKey = apiKey;
    const first = t.runner.send(request(id, "first"));
    expect(t.runner.isRunning(id)).toBe(true);
    expect(t.runner.busy).toBe(true);
    await expect(t.runner.send(request(id, "second"))).resolves.toMatchObject({
      ok: false, failure: { message: { key: "failure.turnRunning" }, retryable: false },
    });
    expect(apiKey).toHaveBeenCalledOnce();
    expect(t.calls).toHaveLength(0);
    key.resolve("sk-test");
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(t.calls).toHaveLength(1);
    expect((await readChat(t.root, id)).turns.filter((turn) => turn.role === "user").map((turn) => turn.text)).toEqual(["first"]);
    expect(t.runner.busy).toBe(false);
  });

  it("remembers cancellation by request id before a new chat's key lookup settles", async () => {
    const t = setup((call) => completed(call.args.outDir as string, "unreached"));
    const key = gate<string | null>();
    t.runner.deps.apiKey = () => key.promise;
    const send = request(null, "cancel before key");
    const pending = t.runner.send(send);
    expect(t.runner.isRunning(send.requestId)).toBe(true);
    t.runner.cancel(send.requestId);
    key.resolve("sk-test");
    await expect(pending).resolves.toMatchObject({ ok: false, cancelled: true, failure: { retryable: false } });
    expect(t.calls).toHaveLength(0);
    expect(t.started).toEqual([]);
    expect(readdirSync(t.root)).toEqual([]);
    expect(t.runner.busy).toBe(false);
  });

  it.each(["unreadable", "replaced", "edited with the same ids"] as const)("preserves an externally %s chat and keeps the paid reply visible without Retry", async (change) => {
    const started = gate<string>();
    const provider = gate<void>();
    const t = setup(async (call) => {
      const dir = call.args.outDir as string;
      started.resolve(dir);
      await provider.promise;
      return completed(dir, "resp_paid");
    });
    const pending = t.runner.send(request(null, "paid reply"));
    const dir = await started.promise;
    const file = join(dir, "chat.json");
    let changed = "{broken external document";
    if (change !== "unreadable") {
      const external = JSON.parse(readFileSync(file, "utf8"));
      if (change === "replaced") {
        external.id = "external-conversation";
        external.title = "External replacement";
        external.turns = [];
      } else external.turns.at(-1).text = "Edited outside while the paid call was running";
      changed = JSON.stringify(external);
    }
    writeFileSync(file, changed);
    provider.resolve();
    const outcome = await pending;
    expect(outcome).toMatchObject({
      ok: false,
      failure: { message: { key: "failure.chatWrite" }, retryable: false },
      chat: { doc: { turns: [expect.objectContaining({ role: "user" }), expect.objectContaining({
        role: "assistant", text: "Here it is.", responseId: "resp_paid", images: ["img.png"],
      })] } },
    });
    expect(readFileSync(file, "utf8")).toBe(changed);
    expect(t.calls).toHaveLength(1);
    expect(t.runner.busy).toBe(false);
  });

  it("retains the staged attachment when saving the initial user turn fails after import", async () => {
    const t = setup((call) => completed(call.args.outDir as string, "unreached"));
    const reference = join(t.root, "staged.png");
    writeFileSync(reference, "staged source");
    let importedPath = "";
    const save = vi.spyOn(chats, "writeChat").mockImplementation(async (_root, id, doc) => {
      const imported = doc.turns[0]!.images[0]!;
      importedPath = join(t.root, id, imported);
      throw new Error("filesystem refused user-turn save");
    });
    const outcome = await t.runner.send(request(null, "retain reference", [reference]));
    expect(save).toHaveBeenCalledOnce();
    expect(readFileSync(importedPath, "utf8")).toBe("staged source");
    expect(outcome).toMatchObject({ ok: false, failure: { message: { key: "failure.chatWrite" }, retryable: false } });
    expect(t.released).toEqual([]);
    expect(readFileSync(reference, "utf8")).toBe("staged source");
    expect(t.calls).toHaveLength(0);
    expect(t.runner.busy).toBe(false);
  });

  it("keeps the chat busy until the assistant save actually settles", async () => {
    const t = setup((call) => completed(call.args.outDir as string, "resp_saved"));
    const id = await emptyChat(t.root);
    const entered = gate<void>();
    const saving = gate<void>();
    const write = chats.writeChat;
    vi.spyOn(chats, "writeChat").mockImplementation(async (root, chatFolder, doc) => {
      if (doc.turns.at(-1)?.role === "assistant") {
        entered.resolve();
        await saving.promise;
      }
      return write(root, chatFolder, doc);
    });
    const pending = t.runner.send(request(id, "save held"));
    await entered.promise;
    expect(t.runner.busy).toBe(true);
    expect(t.runner.isRunning(id)).toBe(true);
    await expect(t.runner.send(request(id, "too early"))).resolves.toMatchObject({
      ok: false, failure: { message: { key: "failure.turnRunning" } },
    });
    expect((await readChat(t.root, id)).turns.map((turn) => turn.role)).toEqual(["user"]);
    saving.resolve();
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect((await readChat(t.root, id)).turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(t.calls).toHaveLength(1);
    expect(t.runner.busy).toBe(false);
  });

  it("a chat reservation blocks Send and Retry before key lookup and allows both after release", async () => {
    let lose = true;
    const t = setup((call) => lose ? dropped : completed(call.args.outDir as string, "resp_after_reservation"));
    const id = await emptyChat(t.root);
    const apiKey = vi.fn(async () => "sk-test");
    t.runner.deps.apiKey = apiKey;
    const release = t.runner.reserveChat(id);
    expect(release).not.toBeNull();
    expect(t.runner.busy).toBe(true);
    expect(t.runner.isRunning(id)).toBe(true);
    expect(t.runner.reserveChat(id)).toBeNull();
    for (const blocked of [t.runner.send(request(id, "blocked")), t.runner.retry(id)]) {
      await expect(blocked).resolves.toMatchObject({
        ok: false, failure: { message: { key: "failure.turnRunning" }, retryable: false },
      });
    }
    expect(apiKey).not.toHaveBeenCalled();
    expect(t.calls).toHaveLength(0);
    expect(t.runner.busy).toBe(true);
    release!();
    expect(t.runner.busy).toBe(false);
    expect(t.runner.isRunning(id)).toBe(false);
    await expect(t.runner.send(request(id, "allowed"))).resolves.toMatchObject({ ok: false });
    lose = false;
    await expect(t.runner.retry(id)).resolves.toMatchObject({ ok: true });
    expect(apiKey).toHaveBeenCalledTimes(2);
    expect(t.calls).toHaveLength(2);
    expect(t.runner.busy).toBe(false);
  });

  it("a released reservation callback cannot release a later owner", async () => {
    const t = setup(() => dropped);
    const id = await emptyChat(t.root);
    const first = t.runner.reserveChat(id)!;
    first();
    const second = t.runner.reserveChat(id)!;
    first();
    expect(t.runner.busy).toBe(true);
    expect(t.runner.isRunning(id)).toBe(true);
    expect(t.runner.reserveChat(id)).toBeNull();
    second();
    second();
    expect(t.runner.busy).toBe(false);
    expect(t.runner.isRunning(id)).toBe(false);
  });

  it("does not reserve a chat already owned by a pending send", async () => {
    const t = setup(() => dropped);
    const id = await emptyChat(t.root);
    const key = gate<string | null>();
    t.runner.deps.apiKey = () => key.promise;
    const pending = t.runner.send(request(id, "already sending"));
    expect(t.runner.reserveChat(id)).toBeNull();
    expect(t.runner.busy).toBe(true);
    key.resolve("sk-test");
    await pending;
    const release = t.runner.reserveChat(id);
    expect(release).not.toBeNull();
    release!();
  });

});
