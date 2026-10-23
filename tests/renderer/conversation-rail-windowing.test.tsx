// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Rail } from "../../src/renderer/src/components/Rail.tsx";
import { Conversation } from "../../src/renderer/src/components/Conversation.tsx";
import type { AssistantTurn, SessionSummary } from "../../src/shared/session.ts";
import { fakeApi, renderInApp } from "./harness.tsx";

beforeEach(() => {
  fakeApi();
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    const children = this.classList.contains("transcript") ? this.querySelector(".column")?.children : this.children;
    return [...children ?? []].reduce((height, node) => height + ((node as HTMLElement).dataset.windowedId ? 700 : parseFloat((node as HTMLElement).style.height) || 0), 0);
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const scroller = this.closest(".transcript, .session-list") as HTMLElement | null;
    return { top: this.getAttribute("aria-hidden") === "true" ? -(scroller?.scrollTop ?? 0) : 0, height: this.classList.contains("session-row") ? 56 : 700 } as DOMRect;
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const at = "2026-10-19T06:00:00.000Z";

it("keeps a long rail bounded while End and Home select and mount offscreen chats", async () => {
  const sessions: SessionSummary[] = Array.from({ length: 1000 }, (_, index) => ({ id: `chat-${index}`, chatId: `chat-${index}`, title: `Chat ${index}`, createdAt: at, updatedAt: at, sentAt: at, cover: "print.png", imageCount: 1 }));
  const opened = vi.fn();
  function Host() {
    const [currentId, setCurrentId] = useState("chat-0");
    return <Rail sessions={sessions} currentId={currentId} running={{}} unreadable={0} failure={null} sessionsDir="/chats" timeZone="UTC" width={null} onWidth={vi.fn()} onNew={vi.fn()} onOpen={(id) => { opened(id); setCurrentId(id); }} onRename={vi.fn()} onTrash={vi.fn()} mac={true} onMenu={vi.fn()} />;
  }
  await renderInApp(() => <Host />);
  expect(screen.getAllByRole("option").length).toBeLessThan(20);
  const list = screen.getByRole("listbox");
  fireEvent.keyDown(list, { key: "End" });
  expect(opened).toHaveBeenLastCalledWith("chat-999");
  const last = screen.getByRole("option", { name: /Chat 999/ });
  expect(last.getAttribute("aria-posinset")).toBe("1000");
  expect(last.getAttribute("aria-setsize")).toBe("1000");
  expect(list.getAttribute("aria-activedescendant")).toBe(last.id);
  expect(list.scrollTop).toBeGreaterThan(60000);
  expect(screen.getAllByRole("option").length).toBeLessThan(20);
  fireEvent.keyDown(list, { key: "Home" });
  expect(opened).toHaveBeenLastCalledWith("chat-0");
  expect(screen.getByText("Chat 0")).toBeTruthy();
});

it("bounds long-transcript images while viewer navigation and totals still include every turn", async () => {
  const turns: AssistantTurn[] = Array.from({ length: 1000 }, (_, index) => ({ id: `turn-${index}`, role: "assistant", at, text: "", images: [`print-${index}.png`], responseId: `r-${index}`, resumed: null, incomplete: null, usage: { input: 1, output: 1 }, failedImages: 0 }));
  const onView = vi.fn();
  function Host() {
    const [current, setCurrent] = useState(turns);
    return <><button onClick={() => setCurrent([...current, { ...turns[0]!, id: "turn-1000", images: ["print-1000.png"] }])}>Append turn</button><Conversation session={{ id: "long-chat", dir: "/chats/long-chat", doc: { format: 1, title: "Long chat", createdAt: at, turns: current } }} openFailure={null} running={null} failure={null} timeZone="UTC" onCancel={vi.fn()} onRetry={vi.fn()} onDismissFailure={vi.fn()} onRename={vi.fn()} onReveal={vi.fn()} imagesPane={false} onToggleImagesPane={vi.fn()} onView={onView} onReuse={vi.fn()} onExport={vi.fn()} exported={null} /></>;
  }
  await renderInApp(() => <Host />);
  expect(document.querySelectorAll(".transcript img").length).toBeLessThan(6);
  expect(document.querySelectorAll("article.turn").length).toBeLessThan(6);
  const transcript = document.querySelector<HTMLElement>(".transcript")!;
  transcript.scrollTop = 100000;
  fireEvent.scroll(transcript);
  expect(document.querySelectorAll(".transcript img").length).toBeLessThan(6);
  fireEvent.click(screen.getAllByRole("button", { name: "Open full size" })[0]!);
  expect(onView).toHaveBeenCalledWith(turns.map((turn) => `/chats/long-chat/${turn.images[0]}`), expect.any(Number));
  expect(screen.getByText(/1,000 images.*2,000 tokens/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Append turn" }));
  expect(document.querySelector('[data-windowed-id="turn-1000"] img')?.getAttribute("src")).toContain("print-1000.png");
  expect(document.querySelectorAll(".transcript img").length).toBeLessThan(6);
});

it("shows a delivered reply's save failure without offering to generate it again", async () => {
  const turn: AssistantTurn = { id: "delivered", role: "assistant", at, text: "", images: ["delivered.png"], responseId: "response", resumed: null, incomplete: null, usage: null, failedImages: 0 };
  await renderInApp(() => <Conversation session={{ id: "chat", dir: "/chats/chat", doc: { format: 1, title: "Chat", createdAt: at, turns: [turn] } }} openFailure={null} running={null} failure={{ message: { key: "failure.sessionWrite" }, retryable: true }} timeZone="UTC" onCancel={vi.fn()} onRetry={vi.fn()} onDismissFailure={vi.fn()} onRename={vi.fn()} onReveal={vi.fn()} imagesPane={false} onToggleImagesPane={vi.fn()} onView={vi.fn()} onReuse={vi.fn()} onExport={vi.fn()} exported={null} />);
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(document.querySelector(".transcript img")?.getAttribute("src")).toContain("delivered.png");
});
