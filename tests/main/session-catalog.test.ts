// Main's session listing reads every session.json only when a folder is first
// listed and when the folder setting changes; each save, rename or trash then
// updates its one entry and sends that one change to the windows.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionCatalog } from "../../src/main/session-catalog.ts";
import { createSession, listSessions, renameSession, writeSession } from "../../src/main/sessions.ts";
import { summarize, SESSION_FILE, type SessionChange } from "../../src/shared/session.ts";
import { completed, request, setup } from "../helpers/turn-runner.ts";

const titles = async (catalog: SessionCatalog, root: string) => (await catalog.list(root)).sessions.map((s) => s.title);

describe("session catalog", () => {
  it("keeps the listing in step with every turn's saves, sending one entry per save", async () => {
    const t = setup((call) => completed(call.args.outDir as string, "resp"));
    expect(await titles(t.catalog, t.root)).toEqual([]);
    const first = await t.runner.send(request(null, "first"));
    await t.runner.send(request(null, "second"));
    if (!first.ok) throw new Error("the first send failed");
    await t.runner.send(request(first.session.id, "again"));
    const listed = await t.catalog.list(t.root);
    expect(listed).toEqual(await listSessions(t.root));
    expect(listed.sessions.map((s) => s.title)).toEqual(["first", "second"]);
    expect(listed.sessions[0]!.imageCount).toBe(2);
    // The user's message and the reply each save once per turn.
    expect(t.changes).toHaveLength(6);
    expect(t.changes.every((change) => change.kind === "entry" && change.session !== null)).toBe(true);
  });

  it("reads the folder once: a session added outside GptImg shows only when the folder is listed anew", async () => {
    const t = setup(() => ({ kind: "error", code: "cancelled" }));
    const outside = async (title: string) => {
      const made = await createSession(t.root, new Date(), title);
      await writeSession(t.root, made.id, made.doc);
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
    const made = await createSession(t.root, new Date(Date.UTC(2026, 0, 1)), "old");
    await writeSession(t.root, made.id, made.doc);
    await t.catalog.list(t.root);
    const renamed = await renameSession(t.root, made.id, "new");
    t.catalog.change(t.root, made.id, summarize(renamed.id, renamed.doc));
    expect((await t.catalog.list(t.root)).sessions.map((s) => [s.id, s.title])).toEqual([[renamed.id, "new"]]);
    t.catalog.change(t.root, renamed.id, null);
    expect(await titles(t.catalog, t.root)).toEqual([]);
  });

  it("puts a change made while the folder is being read into that reply, and sends it no earlier", async () => {
    const t = setup(() => ({ kind: "error", code: "cancelled" }));
    const made = await createSession(t.root, new Date(), "made");
    const order: string[] = [];
    const catalog = new SessionCatalog((change: SessionChange) => order.push(change.kind));
    const listing = catalog.list(t.root).then((l) => { order.push("listed"); return l; });
    catalog.change(t.root, made.id, summarize(made.id, made.doc));
    expect((await listing).sessions).toEqual([]);
    expect((await catalog.list(t.root)).sessions.map((s) => s.title)).toEqual(["made"]);
    expect(order).toEqual(["listed", "entry"]);
  });

  it("retries a failed read on the next listing, and counts unreadable folders", async () => {
    const t = setup(() => ({ kind: "error", code: "cancelled" }));
    const file = join(t.root, "not-a-folder");
    writeFileSync(file, "");
    const catalog = new SessionCatalog(() => {});
    await expect(catalog.list(file)).rejects.toThrow();
    mkdirSync(join(t.root, "broken"));
    writeFileSync(join(t.root, "broken", SESSION_FILE), "{");
    expect(await catalog.list(t.root)).toEqual({ sessions: [], unreadable: 1 });
  });
});
