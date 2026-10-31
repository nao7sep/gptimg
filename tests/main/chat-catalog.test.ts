// Main's chat listing reads every chat.json only when a folder is first
// listed and when the folder setting changes; each save, rename or trash then
// updates its one entry and sends that one change to the windows.
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChatCatalog } from "../../src/main/chat-catalog.ts";
import { createChat, listChats, renameChat, writeChat } from "../../src/main/chats.ts";
import { summarize, CHAT_FILE, type ChatChange } from "../../src/shared/chat.ts";
import { completed, request, setup } from "../helpers/turn-runner.ts";

const titles = async (catalog: ChatCatalog, root: string) => (await catalog.list(root)).chats.map((s) => s.title);

describe("chat catalog", () => {
  it("keeps the listing in step with every turn's saves, sending one entry per save", async () => {
    const t = setup((call) => completed(call.args.outDir as string, "resp"));
    expect(await titles(t.catalog, t.root)).toEqual([]);
    const first = await t.runner.send(request(null, "first"));
    await t.runner.send(request(null, "second"));
    if (!first.ok) throw new Error("the first send failed");
    await t.runner.send(request(first.chat.id, "again"));
    const listed = await t.catalog.list(t.root);
    expect(listed).toEqual(await listChats(t.root));
    expect(listed.chats.map((s) => s.title)).toEqual(["first", "second"]);
    expect(listed.chats[0]!.imageCount).toBe(2);
    // The user's message and the reply each save once per turn.
    expect(t.changes).toHaveLength(6);
    expect(t.changes.every((change) => change.kind === "entry" && change.chat !== null)).toBe(true);
  });

  it("reads the folder once: a chat added outside GptImg shows only when the folder is listed anew", async () => {
    const t = setup(() => ({ kind: "error", code: "cancelled" }));
    const outside = async (title: string) => {
      const made = await createChat(t.root, new Date(), title);
      await writeChat(t.root, made.id, made.doc);
    };
    await outside("one");
    expect(await titles(t.catalog, t.root)).toEqual(["one"]);
    await outside("two");
    expect(await titles(t.catalog, t.root)).toEqual(["one"]);
    t.catalog.folderChanged();
    expect((await titles(t.catalog, t.root)).sort()).toEqual(["one", "two"]);
    expect(t.changes).toContainEqual({ kind: "folder" });
  });

  it("applies a rename and a trash to their one entry", async () => {
    const t = setup(() => ({ kind: "error", code: "cancelled" }));
    const made = await createChat(t.root, new Date(Date.UTC(2026, 0, 1)), "old");
    await writeChat(t.root, made.id, made.doc);
    await t.catalog.list(t.root);
    const renamed = await renameChat(t.root, made.id, "new");
    t.catalog.change(t.root, made.id, summarize(renamed.id, renamed.doc));
    expect((await t.catalog.list(t.root)).chats.map((s) => [s.id, s.title])).toEqual([[renamed.id, "new"]]);
    t.catalog.change(t.root, renamed.id, null);
    expect(await titles(t.catalog, t.root)).toEqual([]);
  });

  it("keeps the true title when a rename writes it and then fails to move the folder", async () => {
    const t = setup(() => ({ kind: "error", code: "cancelled" }));
    const made = await createChat(t.root, new Date(Date.UTC(2026, 0, 1)), "old");
    await writeChat(t.root, made.id, made.doc);
    await t.catalog.list(t.root);
    // A read-only chats folder: the title inside the chat saves, the folder rename fails.
    chmodSync(t.root, 0o555);
    try {
      await expect(renameChat(t.root, made.id, "new")).rejects.toThrow();
    } finally {
      chmodSync(t.root, 0o755);
    }
    await t.catalog.reread(t.root, made.id);
    expect((await t.catalog.list(t.root)).chats.map((s) => [s.id, s.title])).toEqual([[made.id, "new"]]);
    expect(t.changes.at(-1)).toMatchObject({ kind: "entry", id: made.id, chat: { id: made.id, title: "new" } });
    // A chat gone meanwhile leaves the list.
    rmSync(join(t.root, made.id), { recursive: true });
    await t.catalog.reread(t.root, made.id);
    expect(await titles(t.catalog, t.root)).toEqual([]);
  });

  it("puts a change made while the folder is being read into that reply, and sends it no earlier", async () => {
    const t = setup(() => ({ kind: "error", code: "cancelled" }));
    const made = await createChat(t.root, new Date(), "made");
    const order: string[] = [];
    const catalog = new ChatCatalog((change: ChatChange) => order.push(change.kind));
    const listing = catalog.list(t.root).then((l) => { order.push("listed"); return l; });
    catalog.change(t.root, made.id, summarize(made.id, made.doc));
    expect((await listing).chats).toEqual([]);
    expect((await catalog.list(t.root)).chats.map((s) => s.title)).toEqual(["made"]);
    expect(order).toEqual(["listed", "entry"]);
  });

  it("retries a failed read on the next listing, and names refused folders", async () => {
    const t = setup(() => ({ kind: "error", code: "cancelled" }));
    const file = join(t.root, "not-a-folder");
    writeFileSync(file, "");
    const catalog = new ChatCatalog(() => {});
    await expect(catalog.list(file)).rejects.toThrow();
    mkdirSync(join(t.root, "broken"));
    writeFileSync(join(t.root, "broken", CHAT_FILE), "{");
    mkdirSync(join(t.root, "later"));
    writeFileSync(join(t.root, "later", CHAT_FILE), JSON.stringify({ format: { owner: "gptimg", kind: "chat", version: 2 } }));
    expect(await catalog.list(t.root)).toEqual({ chats: [], refused: [{ folder: "broken", reason: "unreadable" }, { folder: "later", reason: "newer" }] });
  });
});
