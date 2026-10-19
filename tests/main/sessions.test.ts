import { mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSession, importReference, isInside, isSessionId, listSessions, readSession, renameSession, withId, writeSession } from "../../src/main/sessions.ts";

const root = () => mkdtempSync(join(tmpdir(), "gptimg-sessions-"));

describe("session folders", () => {
  it("creates a stamped folder and lists sessions newest first", async () => {
    const dir = root();
    const a = await createSession(dir, new Date("2026-10-18T01:00:00Z"), "Older");
    await writeSession(dir, a.id, a.doc);
    const b = await createSession(dir, new Date("2026-10-19T01:00:00Z"), "Newer");
    await writeSession(dir, b.id, b.doc);
    mkdirSync(join(dir, "not-a-session"));
    mkdirSync(join(dir, "broken"));
    writeFileSync(join(dir, "broken", "session.json"), "{");
    const listing = await listSessions(dir);
    expect(listing.sessions.map((s) => s.title)).toEqual(["Newer", "Older"]);
    expect(listing.unreadable).toBe(1);
    expect(a.id).toBe("20261018-010000-utc-Older");
  });

  it("renames the folder with the title, keeping its stamp", async () => {
    const dir = root();
    const s = await createSession(dir, new Date("2026-10-19T01:00:00Z"), "First words");
    await writeSession(dir, s.id, s.doc);
    const renamed = await renameSession(dir, s.id, "Cats: a study");
    expect(renamed.id).toBe("20261019-010000-utc-Cats a study");
    expect((await readSession(dir, renamed.id)).title).toBe("Cats: a study");
    expect(readdirSync(dir)).toEqual([renamed.id]);
  });

  it("copies a reference into inputs/ keeping its modified time, and leaves a session file where it is", async () => {
    const dir = root();
    const s = await createSession(dir, new Date("2026-10-19T01:00:00Z"), "x");
    const sessionDir = join(dir, s.id);
    const source = join(root(), "photo.PNG");
    writeFileSync(source, "png-bytes");
    utimesSync(source, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    const rel = await importReference(sessionDir, source, new Date("2026-10-19T02:00:00Z"));
    expect(rel).toBe("inputs/20261019-020000-utc-photo.png");
    expect(statSync(join(sessionDir, rel)).mtime.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    writeFileSync(join(sessionDir, "made.png"), "x");
    expect(await importReference(sessionDir, join(sessionDir, "made.png"), new Date())).toBe("made.png");
  });

  it("refuses ids that are paths", () => {
    expect(isSessionId("a")).toBe(true);
    for (const id of ["", ".", "..", "a/b", "a\\b"]) expect(isSessionId(id)).toBe(false);
    expect(isInside("/s", "/s/x/y.png")).toBe(true);
    expect(isInside("/s", "/s/../t.png")).toBe(false);
    expect(isInside("/s", "/s")).toBe(false);
  });
});

describe("a chat's lasting id", () => {
  it("is given at creation and kept through a rename", async () => {
    const dir = root();
    const s = await createSession(dir, new Date("2026-10-19T01:00:00Z"), "First");
    expect(s.doc.id).toMatch(/^[0-9a-f-]{36}$/);
    await writeSession(dir, s.id, s.doc);
    const renamed = await renameSession(dir, s.id, "Second");
    expect(renamed.doc.id).toBe(s.doc.id);
  });

  it("is added to an older chat only when it is next written", () => {
    const old = { format: 1 as const, title: "t", createdAt: "2026-10-01T00:00:00.000Z", turns: [] };
    expect(withId(old).id).toMatch(/^[0-9a-f-]{36}$/);
    const kept = { ...old, id: "abc" };
    expect(withId(kept)).toBe(kept);
  });
});
