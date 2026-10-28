// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GptImgApi } from "../../src/shared/api.ts";
import type { RecordDetail, RecordQuery, RecordRow, RecordsPage } from "../../src/shared/records.ts";
import type { Settings } from "../../src/shared/settings.ts";
import { RecordsWindow } from "../../src/renderer/src/records/RecordsWindow.tsx";
import { bootInfo, fakeApi, renderInApp } from "./harness.tsx";

afterEach(cleanup);
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
  const sessions = new Set<() => void>();
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
    emitSessions: () => sessions.forEach((handler) => handler()),
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
    fireEvent.scroll(screen.getByRole("listbox"));
    await screen.findByText("Row 100");
    expect(screen.getByText("Row 0")).toBeDefined();
    expect(document.querySelectorAll(".record-card")).toHaveLength(200);
    fireEvent.scroll(screen.getByRole("listbox"));
    expect(queryRecords.mock.calls.map(([query]) => query.cursor?.id)).toEqual([undefined, 99]);
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
    const list = screen.getByRole("listbox");
    list.scrollTop = 30;
    await act(async () => t.emitRecords());
    expect(queryRecords).toHaveBeenCalledTimes(2);
  });

  it("resets the list, selection and detail when filters change, ignoring a query the change outdated", async () => {
    const late = deferred<RecordsPage>();
    const queryRecords = vi.fn<(query: RecordQuery) => Promise<RecordsPage>>()
      .mockResolvedValueOnce(page(0)).mockResolvedValueOnce(page(100)).mockImplementationOnce(() => late.promise).mockResolvedValueOnce(page(400, 1, false));
    const t = setup({ queryRecords, recordDetail: vi.fn(async ({ id }) => detail(id)) });
    await t.render();
    await screen.findByText("Row 0");
    fireEvent.scroll(screen.getByRole("listbox"));
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
    fireEvent.scroll(screen.getByRole("listbox"));
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
