import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChat, listChats, readChat, renameChat, writeChat } from "../../src/main/chats.ts";

vi.mock("node:fs/promises", async (actual) => {
  const original = await actual<typeof fs>();
  return { ...original, rename: vi.fn(original.rename), readFile: vi.fn(original.readFile) };
});
afterEach(() => vi.restoreAllMocks());
const root = () => mkdtempSync(join(tmpdir(), "gptimg-chat-failure-"));

describe("chat failure preservation", () => {
  it("keeps the old folder and identity discoverable when its move fails after saving the title", async () => {
    const dir = root();
    const chat = await createChat(dir, new Date("2026-10-19T00:00:00Z"), "old");
    await writeChat(dir, chat.id, chat.doc);
    const actualRename = vi.mocked(fs.rename).getMockImplementation();
    vi.mocked(fs.rename).mockImplementation(async (source, target) => {
      if (String(source).endsWith(".tmp")) return actualRename!(source, target);
      throw new Error("move failed");
    });
    await expect(renameChat(dir, chat.id, "new")).rejects.toThrow("move failed");
    expect(readdirSync(dir)).toEqual([chat.id]);
    expect(await readChat(dir, chat.id)).toMatchObject({ title: "new", id: chat.doc.id });
    expect((await listChats(dir)).chats).toMatchObject([{ id: chat.id, title: "new", chatId: chat.doc.id }]);
  });

  it("counts inaccessible entries and continues reading independent chats", async () => {
    const dir = root();
    const chat = await createChat(dir, new Date("2026-10-19T00:00:00Z"), "good");
    await writeChat(dir, chat.id, chat.doc);
    mkdirSync(join(dir, "inaccessible"));
    writeFileSync(join(dir, "inaccessible", "chat.json"), "{}");
    const actualReadFile = vi.mocked(fs.readFile).getMockImplementation()!;
    vi.mocked(fs.readFile).mockImplementation(async (path, options) => {
      if (String(path).includes("inaccessible")) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return actualReadFile(path, options);
    });
    const listed = await listChats(dir);
    expect(listed.unreadable).toBe(1);
    expect(listed.chats.map((entry) => entry.title)).toEqual(["good"]);
  });
});
