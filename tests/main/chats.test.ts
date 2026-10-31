import { mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createChat, importReference, isInside, isChatFolder, listChats, readChat, renameChat, writeChat } from "../../src/main/chats.ts";

const root = () => mkdtempSync(join(tmpdir(), "gptimg-chats-"));

describe("chat folders", () => {
  it("creates a stamped folder and lists chats newest first", async () => {
    const dir = root();
    const a = await createChat(dir, new Date("2026-10-18T01:00:00Z"), "Older");
    await writeChat(dir, a.id, a.doc);
    const b = await createChat(dir, new Date("2026-10-19T01:00:00Z"), "Newer");
    await writeChat(dir, b.id, b.doc);
    mkdirSync(join(dir, "not-a-chat"));
    mkdirSync(join(dir, "broken"));
    writeFileSync(join(dir, "broken", "chat.json"), "{");
    const listing = await listChats(dir);
    expect(listing.chats.map((s) => s.title)).toEqual(["Newer", "Older"]);
    expect(listing.refused).toEqual([{ folder: "broken", reason: "unreadable" }]);
    expect(a.id).toBe("20261018-010000-utc-Older");
  });

  it("renames the folder with the title, keeping its stamp", async () => {
    const dir = root();
    const s = await createChat(dir, new Date("2026-10-19T01:00:00Z"), "First words");
    await writeChat(dir, s.id, s.doc);
    const renamed = await renameChat(dir, s.id, "Cats: a study");
    expect(renamed.id).toBe("20261019-010000-utc-Cats a study");
    expect((await readChat(dir, renamed.id)).title).toBe("Cats: a study");
    expect(readdirSync(dir)).toEqual([renamed.id]);
  });

  it("copies a reference into inputs/ keeping its modified time, and leaves a chat file where it is", async () => {
    const dir = root();
    const s = await createChat(dir, new Date("2026-10-19T01:00:00Z"), "x");
    const chatDir = join(dir, s.id);
    const source = join(root(), "photo.PNG");
    writeFileSync(source, "png-bytes");
    utimesSync(source, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    const rel = await importReference(chatDir, source, new Date("2026-10-19T02:00:00Z"));
    expect(rel).toBe("inputs/20261019-020000-utc-photo.png");
    expect(statSync(join(chatDir, rel)).mtime.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    writeFileSync(join(chatDir, "made.png"), "x");
    expect(await importReference(chatDir, join(chatDir, "made.png"), new Date())).toBe("made.png");
  });

  it("refuses ids that are paths", () => {
    expect(isChatFolder("a")).toBe(true);
    for (const id of ["", ".", "..", "a/b", "a\\b", "a\u0000b"]) expect(isChatFolder(id)).toBe(false);
    expect(isInside("/s", "/s/x/y.png")).toBe(true);
    expect(isInside("/s", "/s/..x.png")).toBe(true);
    expect(isInside("/s", "/s/../t.png")).toBe(false);
    expect(isInside("/s", "/s")).toBe(false);
  });
});

describe("a chat's lasting id", () => {
  it("is given at creation and kept through a rename", async () => {
    const dir = root();
    const s = await createChat(dir, new Date("2026-10-19T01:00:00Z"), "First");
    expect(s.doc.id).toMatch(/^[0-9a-f-]{36}$/);
    await writeChat(dir, s.id, s.doc);
    const renamed = await renameChat(dir, s.id, "Second");
    expect(renamed.doc.id).toBe(s.doc.id);
  });

  it("is required: a chat.json without one is not read", async () => {
    const dir = root();
    const s = await createChat(dir, new Date("2026-10-19T01:00:00Z"), "x");
    const { id: _, ...noId } = s.doc;
    writeFileSync(join(dir, s.id, "chat.json"), JSON.stringify(noId));
    await expect(readChat(dir, s.id)).rejects.toMatchObject({ code: "malformed" });
  });
});
