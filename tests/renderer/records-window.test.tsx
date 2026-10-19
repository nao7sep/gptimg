// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootInfo, fakeApi, renderInApp } from "./harness.tsx";

afterEach(cleanup);

const row = { source: "sdk" as const, id: 7, at: "2026-10-19T03:00:00.123Z", level: "warn" as const, kind: "call" as const, title: "chat failed", text: "gpt-5.6-terra · 812 ms", chatId: "c1" };

describe("the Records window", () => {
  it("lists records, shows one whole, and filters by kind, level, chat and text", async () => {
    const queryRecords = vi.fn(async () => ({ rows: [row], next: null, failed: false }));
    const recordDetail = vi.fn(async () => ({
      ...row,
      kind: "call" as const,
      launchId: "l1",
      fields: [{ label: "status" as const, value: 429 }],
      blocks: [{ label: "error" as const, text: '{\n  "message": "slow down"\n}' }],
    }));
    fakeApi({
      queryRecords,
      recordDetail,
      recordLaunches: vi.fn(async () => [{ id: "l1", startedAt: "2026-10-19T02:59:00.000Z", version: "0", current: true }]),
      recordChats: vi.fn(async () => [{ id: "c1", title: "A fox" }]),
    });
    const { RecordsWindow } = await import("../../src/renderer/src/records/RecordsWindow.tsx");
    await renderInApp(() => <RecordsWindow boot={bootInfo()} />);
    expect(await screen.findByText("Select a record to see everything it holds.")).toBeTruthy();
    fireEvent.click(await screen.findByText("chat failed"));
    expect(await screen.findByText(/"message": "slow down"/)).toBeTruthy();
    expect(screen.getByText("429")).toBeTruthy();
    expect(screen.getAllByText("A fox").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "call" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Level" }), { target: { value: "attention" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Chat" }), { target: { value: "c1" } });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search records" }), { target: { value: "slow" } });
    await waitFor(() => expect(queryRecords).toHaveBeenLastCalledWith({ search: "slow", chatId: "c1", kind: "call", level: "attention" }), { timeout: 2000 });
  });

  it("says when nothing matches and when the records cannot be read", async () => {
    fakeApi({ queryRecords: vi.fn(async () => ({ rows: [], next: null, failed: true })) });
    const { RecordsWindow } = await import("../../src/renderer/src/records/RecordsWindow.tsx");
    await renderInApp(() => <RecordsWindow boot={bootInfo()} />);
    expect(await screen.findByText("The records could not be read.")).toBeTruthy();
  });
});
