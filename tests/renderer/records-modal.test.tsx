// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeApi, renderInApp } from "./harness.tsx";

afterEach(cleanup);

describe("the records window", () => {
  it("lists records, opens one whole and switches kind and chat", async () => {
    const queryRecords = vi.fn(async () => ({
      rows: [{ id: 7, at: "2026-10-19T03:00:00.000Z", level: "info" as const, event: "turn.replied", summary: "reply received", chatId: "c1" }],
      more: false,
      unavailable: false,
    }));
    const recordDetail = vi.fn(async () => ({ kind: "log" as const, id: 7, columns: { event: "turn.replied" }, body: { images: 1 } }));
    fakeApi({ queryRecords, recordDetail });
    const { RecordsModal } = await import("../../src/renderer/src/modals/RecordsModal.tsx");
    await renderInApp(() => <RecordsModal chatId="c1" timeZone="UTC" onClose={() => {}} />);
    fireEvent.click(await screen.findByText("reply received"));
    expect(await screen.findByText(/"images": 1/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "OpenAI calls" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "This chat only" }));
    await waitFor(() => expect(queryRecords).toHaveBeenLastCalledWith({ kind: "calls", scope: "launch", chatId: "c1" }));
  });
});
