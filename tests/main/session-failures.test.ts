import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession, listSessions, readSession, renameSession, writeSession } from "../../src/main/sessions.ts";

vi.mock("node:fs/promises", async (actual) => {
  const original = await actual<typeof fs>();
  return { ...original, rename: vi.fn(original.rename), realpath: vi.fn(original.realpath) };
});
afterEach(() => vi.restoreAllMocks());
const root = () => mkdtempSync(join(tmpdir(), "gptimg-session-failure-"));

describe("session failure preservation", () => {
  it("keeps the old folder and identity discoverable when its move fails after saving the title", async () => {
    const dir = root();
    const session = await createSession(dir, new Date("2026-10-19T00:00:00Z"), "old");
    await writeSession(dir, session.id, session.doc);
    const actualRename = vi.mocked(fs.rename).getMockImplementation();
    vi.mocked(fs.rename).mockImplementation(async (source, target) => {
      if (String(source).endsWith(".tmp")) return actualRename!(source, target);
      throw new Error("move failed");
    });
    await expect(renameSession(dir, session.id, "new")).rejects.toThrow("move failed");
    expect(readdirSync(dir)).toEqual([session.id]);
    expect(await readSession(dir, session.id)).toMatchObject({ title: "new", id: session.doc.id });
    expect((await listSessions(dir)).sessions).toMatchObject([{ id: session.id, title: "new", chatId: session.doc.id }]);
  });

  it("counts inaccessible entries and continues reading independent sessions", async () => {
    const dir = root();
    const session = await createSession(dir, new Date("2026-10-19T00:00:00Z"), "good");
    await writeSession(dir, session.id, session.doc);
    mkdirSync(join(dir, "inaccessible"));
    const actualRealpath = vi.mocked(fs.realpath).getMockImplementation()!;
    vi.mocked(fs.realpath).mockImplementation(async (path, options) => {
      if (String(path).includes("inaccessible")) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return actualRealpath(path, options);
    });
    const listed = await listSessions(dir);
    expect(listed.unreadable).toBe(1);
    expect(listed.sessions.map((entry) => entry.title)).toEqual(["good"]);
  });
});
