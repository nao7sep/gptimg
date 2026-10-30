// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { GptImgApi } from "../../src/shared/api.ts";
import type { RecordDetail, RecordQuery, RecordRow, RecordsPage } from "../../src/shared/records.ts";
import type { Settings } from "../../src/shared/settings.ts";
import type { SessionChange } from "../../src/shared/session.ts";
import { RecordsWindow } from "../../src/renderer/src/records/RecordsWindow.tsx";
import { bootInfo, fakeApi, renderInApp } from "./harness.tsx";

afterEach(cleanup);

// jsdom lays nothing out, so the list reports the geometry a window would:
// a 500px visible height over 50px rows, and an offset kept within them.
const ROW = 50;
const VISIBLE = 500;
const offsets = new WeakMap<Element, number>();
const isList = (el: Element) => el.classList.contains("records-rows");
const contentHeight = (el: Element) => Math.max(VISIBLE, el.children.length * ROW);
const geometry = {
  clientHeight: { get(this: Element) { return isList(this) ? VISIBLE : 0; } },
  scrollHeight: { get(this: Element) { return isList(this) ? contentHeight(this) : 0; } },
  scrollTop: {
    get(this: Element) { return offsets.get(this) ?? 0; },
    set(this: Element, value: number) { offsets.set(this, Math.max(0, Math.min(value, isList(this) ? contentHeight(this) - VISIBLE : 0))); },
  },
};
const originals = Object.fromEntries(Object.keys(geometry).map((key) => [key, Object.getOwnPropertyDescriptor(Element.prototype, key)]));
beforeAll(() => { for (const [key, descriptor] of Object.entries(geometry)) Object.defineProperty(Element.prototype, key, { ...descriptor, configurable: true }); });
afterAll(() => { for (const [key, descriptor] of Object.entries(originals)) if (descriptor) Object.defineProperty(Element.prototype, key, descriptor); });

const listbox = () => document.querySelector<HTMLElement>(".records-rows")!;
const scrollTo = (offset: number) => { listbox().scrollTop = offset; fireEvent.scroll(listbox()); };
const scrollToEnd = () => scrollTo(listbox().scrollHeight);
const cards = () => [...document.querySelectorAll(".record-card")].map((card) => card.querySelector(".record-title")!.textContent);
const at = "2026-10-19T01:02:03.004Z";
const row = (id: number): RecordRow => ({ id, source: "app", at, level: "info", kind: "log", title: `Row ${id}`, text: "", chatId: null });
const detail = (id: number): RecordDetail => ({ ...row(id), text: `Detail ${id}`, launchId: "launch", fields: [], blocks: [] });
const page = (start: number, count = 100, more = true): RecordsPage => ({ rows: Array.from({ length: count }, (_, i) => row(start + i)), next: more ? { at, source: "app", id: start + count - 1 } : null, failed: false });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const filters = () => within(document.querySelector<HTMLElement>(".records-filters")!);

function setup(over: Partial<GptImgApi> = {}) {
  const records = new Set<() => void>();
  const sessions = new Set<(change: SessionChange) => void>();
  const settings = new Set<(value: Settings) => void>();
  const api = fakeApi({
    onRecordsChanged: (handler) => { records.add(handler); return () => { records.delete(handler); }; },
    onSessionsChanged: (handler) => { sessions.add(handler); return () => { sessions.delete(handler); }; },
    onSettings: (handler) => { settings.add(handler); return () => { settings.delete(handler); }; },
    ...over,
  });
  return {
    api, records, sessions, settings,
    emitRecords: () => records.forEach((handler) => handler()),
    emitSessions: () => sessions.forEach((handler) => handler({ kind: "folder" })),
    emitSettings: (value: Settings) => settings.forEach((handler) => handler(value)),
    render: async () => { const boot = bootInfo(); boot.settings.timeZone = "UTC"; return renderInApp(() => <RecordsWindow boot={boot} />); },
  };
}

describe("Records list", () => {
  it("loads older records as the list nears its end, keeping the ones shown", async () => {
    const queryRecords = vi.fn(async (query: RecordQuery) => !query.cursor ? page(0) : page(100, 100, false));
    const t = setup({ queryRecords });
    await t.render();
    await screen.findByText("Row 0");
    // More than a visible height left below: nothing more is read.
    scrollTo(5000 - 2 * VISIBLE - 1);
    expect(queryRecords).toHaveBeenCalledOnce();
    // No more than a visible height left: the next page.
    scrollTo(5000 - 2 * VISIBLE);
    await screen.findByText("Row 100");
    expect(screen.getByText("Row 0")).toBeDefined();
    expect(document.querySelectorAll(".record-card")).toHaveLength(200);
    scrollToEnd();
    expect(queryRecords.mock.calls.map(([query]) => query.cursor?.id)).toEqual([undefined, 99]);
  });

  it("reads further pages until what is left below is taller than the visible part", async () => {
    // Six 50px rows a page against a 500px window: 300, 600, 900, then 1200px leaves 700px below.
    const queryRecords = vi.fn(async (query: RecordQuery) => page(query.cursor ? query.cursor.id + 1 : 0, 6));
    const t = setup({ queryRecords });
    await t.render();
    await screen.findByText("Row 23");
    await act(async () => {});
    expect(cards()).toHaveLength(24);
    expect(queryRecords).toHaveBeenCalledTimes(4);
  });

  it("joins new records at the top only while the list is scrolled there", async () => {
    const queryRecords = vi.fn(async () => page(0, 1, false));
    const t = setup({ queryRecords });
    await t.render();
    await screen.findByText("Row 0");
    queryRecords.mockResolvedValueOnce(page(1, 1, false));
    await act(async () => t.emitRecords());
    await screen.findByText("Row 1");
    expect([...document.querySelectorAll(".record-card")].map((card) => card.textContent)).toEqual([expect.stringContaining("Row 1"), expect.stringContaining("Row 0")]);
  });

  it("holds new records while scrolled away, including a page already being read, and shows them back at the top", async () => {
    const late = deferred<RecordsPage>();
    const queryRecords = vi.fn<(query: RecordQuery) => Promise<RecordsPage>>().mockResolvedValueOnce(page(10, 20, false));
    const t = setup({ queryRecords });
    await t.render();
    await screen.findByText("Row 10");
    queryRecords.mockImplementationOnce(() => late.promise);
    await act(async () => t.emitRecords());
    scrollTo(1);
    await act(async () => late.resolve({ rows: [row(9), ...page(10, 20, false).rows], next: null, failed: false }));
    await act(async () => t.emitRecords());
    expect(queryRecords).toHaveBeenCalledTimes(2);
    expect(cards()[0]).toBe("Row 10");
    expect(listbox().scrollTop).toBe(1);
    queryRecords.mockResolvedValueOnce({ rows: [row(8), row(9), ...page(10, 20, false).rows], next: null, failed: false });
    scrollTo(0.5);
    await screen.findByText("Row 8");
    expect(cards().slice(0, 3)).toEqual(["Row 8", "Row 9", "Row 10"]);
  });

  it("resets the list, selection and detail when filters change, ignoring a query the change outdated", async () => {
    const late = deferred<RecordsPage>();
    const queryRecords = vi.fn<(query: RecordQuery) => Promise<RecordsPage>>()
      .mockResolvedValueOnce(page(0)).mockResolvedValueOnce(page(100)).mockImplementationOnce(() => late.promise).mockResolvedValueOnce(page(400, 1, false));
    const t = setup({ queryRecords, recordDetail: vi.fn(async ({ id }) => detail(id)) });
    await t.render();
    await screen.findByText("Row 0");
    scrollToEnd();
    await screen.findByText("Row 100");
    fireEvent.click(screen.getByText("Row 100"));
    await screen.findByText("Detail 100");
    fireEvent.change(filters().getByRole("combobox", { name: "Kind" }), { target: { value: "call" } });
    expect(screen.queryByText("Detail 100")).toBeNull();
    expect(document.querySelectorAll(".record-card")).toHaveLength(0);
    await act(async () => {});
    expect(queryRecords).toHaveBeenCalledTimes(3);
    fireEvent.change(filters().getByRole("combobox", { name: "Level" }), { target: { value: "error" } });
    await act(async () => late.resolve(page(300, 1, false)));
    await screen.findByText("Row 400");
    expect(screen.queryByText("Row 300")).toBeNull();
    expect(screen.getByText("Row 400")).toBeDefined();
    expect(document.querySelector('[aria-selected="true"]')).toBeNull();
    expect(queryRecords.mock.calls.at(-1)?.[0]).toEqual({ kind: "call", level: "error" });
  });

  it("shows readable history alongside a degraded-store warning and keeps loading older records", async () => {
    const queryRecords = vi.fn(async () => ({ ...page(0, 1), failed: true }));
    const t = setup({ queryRecords });
    await t.render();
    await screen.findByText("Row 0");
    expect(screen.getByRole("alert")).toBeDefined();
    queryRecords.mockResolvedValueOnce({ ...page(1, 1, false), failed: true });
    scrollToEnd();
    await screen.findByText("Row 1");
    expect(screen.getByText("Row 0")).toBeDefined();
    expect(screen.getByRole("alert")).toBeDefined();
  });

  it("keeps valid rows through refresh failures and clears the warning on a later success", async () => {
    const queryRecords = vi.fn(async () => page(0, 1, false));
    const t = setup({ queryRecords });
    await t.render();
    await screen.findByText("Row 0");
    queryRecords.mockResolvedValueOnce({ rows: [], next: null, failed: true });
    await act(async () => t.emitRecords());
    await screen.findByRole("alert");
    expect(screen.getByText("Row 0")).toBeDefined();
    queryRecords.mockRejectedValueOnce(new Error("private error"));
    await act(async () => t.emitRecords());
    await screen.findByRole("alert");
    expect(screen.queryByText("private error")).toBeNull();
    expect(screen.getByText("Row 0")).toBeDefined();
    queryRecords.mockResolvedValueOnce(page(2, 1, false));
    await act(async () => t.emitRecords());
    await screen.findByText("Row 2");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reads live refreshes one at a time, each joining the top in turn", async () => {
    const first = deferred<RecordsPage>();
    const second = deferred<RecordsPage>();
    const queryRecords = vi.fn(async () => page(0, 1, false));
    const t = setup({ queryRecords });
    await t.render();
    await screen.findByText("Row 0");
    queryRecords.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    await act(async () => { t.emitRecords(); t.emitRecords(); });
    expect(queryRecords).toHaveBeenCalledTimes(2);
    await act(async () => first.resolve(page(1, 1, false)));
    await screen.findByText("Row 1");
    expect(queryRecords).toHaveBeenCalledTimes(3);
    await act(async () => second.resolve(page(2, 1, false)));
    await screen.findByText("Row 2");
    expect([...document.querySelectorAll(".record-card")].map((card) => card.textContent)).toEqual([
      expect.stringContaining("Row 2"), expect.stringContaining("Row 1"), expect.stringContaining("Row 0"),
    ]);
  });
});

describe("Records over 10,000 records arriving live", () => {
  it("shows arrivals at the top, holds still while scrolled away, and pages every record once in order", async () => {
    // The store: ids grow with arrival, newest first by id, paged by cursor.
    let stored = 0;
    let gate: Promise<void> | null = null;
    const queryRecords = vi.fn(async (query: RecordQuery): Promise<RecordsPage> => {
      const snapshot = stored;
      if (gate) await gate;
      const top = query.cursor ? query.cursor.id - 1 : snapshot - 1;
      const ids = Array.from({ length: Math.max(0, Math.min(100, top + 1)) }, (_, i) => top - i);
      const last = ids.at(-1);
      return { rows: ids.map(row), next: last !== undefined && last > 0 ? { at, source: "app", id: last } : null, failed: false };
    });
    const recordDetail = vi.fn(async ({ id }: { id: number }) => detail(id));
    const t = setup({ queryRecords, recordDetail });
    await t.render();
    const arrive = async (count: number) => {
      stored += count;
      await act(async () => t.emitRecords());
    };

    // At the top, each arrival joins the list at once.
    for (let i = 0; i < 50; i++) await arrive(60);
    expect(cards()).toHaveLength(3000);
    expect(cards()[0]).toBe("Row 2999");

    fireEvent.click(screen.getByText("Row 2995"));
    await screen.findByText("Detail 2995");

    // A newest page read while at the top, landing after the list left it, is held.
    let open!: () => void;
    gate = new Promise((done) => { open = done; });
    await arrive(10);
    scrollTo(1234);
    const before = { shown: cards(), offset: listbox().scrollTop };
    await act(async () => { open(); gate = null; });

    // Scrolled away, nothing moves however many arrive.
    const calls = queryRecords.mock.calls.length;
    for (let i = 0; i < 40; i++) await arrive(100);
    expect(queryRecords.mock.calls.length).toBe(calls);
    expect(cards()).toEqual(before.shown);
    expect(listbox().scrollTop).toBe(before.offset);
    expect(document.querySelector('[aria-selected="true"]')?.textContent).toContain("Row 2995");
    expect(screen.getByText("Detail 2995")).toBeDefined();

    // Back at the top, the newest appear; more than a page of them start the list afresh.
    scrollTo(0);
    await screen.findByText("Row 7009");
    expect(cards()).toHaveLength(100);
    expect(screen.getByText("Detail 2995")).toBeDefined();
    while (stored < 10_000) await arrive(Math.min(73, 10_000 - stored));
    expect(cards()[0]).toBe("Row 9999");

    // Paging down reaches the oldest, each record once, newest first.
    for (let guard = 0; guard < 200 && listbox().children.length < 10_000; guard++) await act(async () => scrollToEnd());
    expect(cards()).toEqual(Array.from({ length: 10_000 }, (_, i) => `Row ${9999 - i}`));
  });
});

describe("Records details and live settings", () => {
  it("clears the old detail on selection and ignores detail results that another selection or a filter change outdated", async () => {
    const old = deferred<RecordDetail | null>();
    const next = deferred<RecordDetail | null>();
    const late = deferred<RecordDetail | null>();
    const recordDetail = vi.fn<(ref: { source: "app" | "sdk"; id: number }) => Promise<RecordDetail | null>>()
      .mockImplementationOnce(() => old.promise).mockImplementationOnce(() => next.promise).mockImplementationOnce(() => late.promise).mockResolvedValue(null);
    const t = setup({ queryRecords: vi.fn(async () => page(0, 2, false)), recordDetail });
    await t.render();
    await screen.findByText("Row 0");
    fireEvent.click(screen.getByText("Row 0"));
    await act(async () => {});
    expect(recordDetail).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("Row 1"));
    await act(async () => old.resolve(detail(0)));
    expect(screen.queryByText("Detail 0")).toBeNull();
    await act(async () => next.resolve(detail(1)));
    await screen.findByText("Detail 1");
    fireEvent.click(screen.getByText("Row 0"));
    expect(screen.queryByText("Detail 1")).toBeNull();
    await act(async () => {});
    expect(recordDetail).toHaveBeenCalledTimes(3);
    fireEvent.change(filters().getByRole("combobox", { name: "Kind" }), { target: { value: "call" } });
    await act(async () => late.resolve(detail(0)));
    expect(screen.queryByText("Detail 0")).toBeNull();
  });

  it("updates font settings and displayed time zone live", async () => {
    const t = setup({ queryRecords: vi.fn(async () => page(0, 1, false)) });
    await t.render();
    await screen.findByText(/01:02:03\.004/);
    const settings = { ...bootInfo().settings, timeZone: "Asia/Tokyo", uiFont: "Updated Font", contentFont: { ...bootInfo().settings.contentFont, family: "Updated Content" } };
    await act(async () => t.emitSettings(settings));
    await screen.findByText(/10:02:03\.004/);
    expect(document.documentElement.style.getPropertyValue("--font-ui")).toBe("Updated Font");
    expect(document.documentElement.style.getPropertyValue("--font-content")).toBe("Updated Content");
  });

  it("refreshes chat names in the order they were read and cleans up all subscriptions on unmount", async () => {
    const first = deferred<Array<{ id: string; title: string }>>();
    const second = deferred<Array<{ id: string; title: string }>>();
    const recordChats = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const t = setup({ recordChats });
    const rendered = await t.render();
    await act(async () => t.emitSessions());
    expect(recordChats).toHaveBeenCalledOnce();
    await act(async () => first.resolve([{ id: "chat", title: "Stale chat title" }]));
    await act(async () => second.resolve([{ id: "chat", title: "Current chat title" }]));
    await screen.findByRole("option", { name: "Current chat title" });
    expect(screen.queryByRole("option", { name: "Stale chat title" })).toBeNull();
    rendered.unmount();
    expect(t.records.size).toBe(0);
    expect(t.sessions.size).toBe(0);
    expect(t.settings.size).toBe(0);
  });
});
