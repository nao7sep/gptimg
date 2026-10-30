// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AppFailure, BootInfo, GptImgApi, MenuCommand, OpenedSession, SessionsListing } from "../../src/shared/api.ts";
import { summarize, type SessionChange } from "../../src/shared/session.ts";
import { bootInfo, fakeApi, renderInApp } from "./harness.tsx";
import { App } from "../../src/renderer/src/App.tsx";

vi.mock("../../src/renderer/src/components/Rail.tsx", () => ({ Rail: (props: { sessions: { id: string; title: string }[]; onOpen: (id: string) => void; onNew: () => void }) => <nav><button onClick={props.onNew}>New chat</button>{props.sessions.map((session) => <button key={session.id} onClick={() => props.onOpen(session.id)}>{session.title}</button>)}</nav> }));
vi.mock("../../src/renderer/src/components/Conversation.tsx", () => ({ Conversation: (props: { session: OpenedSession | null; failure: AppFailure | null }) => <section data-testid="conversation">{props.session?.doc.title}{props.failure && <p role="alert">Failed send</p>}</section> }));
vi.mock("../../src/renderer/src/components/ImagesPane.tsx", () => ({ ImagesPane: () => null, paneImages: () => [] }));

afterEach(cleanup);

const failure: AppFailure = { message: { key: "failure.internal" }, retryable: false };
const at = "2026-10-23T00:00:00.000Z";
function session(id: string): OpenedSession { return { id, dir: `/chats/${id}`, doc: { format: 1, title: id, createdAt: at, turns: [] } }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

async function mount(over: Partial<GptImgApi> = {}, boot: BootInfo = bootInfo()) {
  let menu: (command: MenuCommand) => void = () => {};
  const api = fakeApi({
    listSessions: vi.fn<GptImgApi["listSessions"]>(async () => ({ ok: true, sessions: [summarize("A", session("A").doc), summarize("B", session("B").doc)], unreadable: 0 })),
    openSession: vi.fn<GptImgApi["openSession"]>(async (id: string) => ({ ok: true, session: session(id) })),
    onTurnDraft: () => () => {},
    onMenu: (handler) => { menu = handler; return () => {}; },
    saveState: vi.fn(), setWindowDirty: vi.fn(),
    send: vi.fn<GptImgApi["send"]>(async () => ({ ok: false, session: null, cancelled: false, failure })),
    ...over,
  });
  const rendered = await renderInApp(() => <App boot={boot} />);
  return { api, rendered, menu: (command: MenuCommand) => act(() => menu(command)) };
}

it("ignores an old open completion after another chat is chosen", async () => {
  const old = deferred<Awaited<ReturnType<GptImgApi["openSession"]>>>();
  await mount({ openSession: vi.fn<GptImgApi["openSession"]>((id) => id === "A" ? old.promise : Promise.resolve({ ok: true, session: session(id) })) });
  fireEvent.click(await screen.findByRole("button", { name: "A" }));
  fireEvent.click(screen.getByRole("button", { name: "B" }));
  await waitFor(() => expect(screen.getByTestId("conversation").textContent).toBe("B"));
  await act(async () => old.resolve({ ok: true, session: session("A") }));
  expect(screen.getByTestId("conversation").textContent).toBe("B");
});

it("ignores an old chat-list completion after the settings folder changes", async () => {
  const old = deferred<{ ok: true } & SessionsListing>();
  const { api, menu } = await mount({ listSessions: vi.fn<GptImgApi["listSessions"]>().mockReturnValueOnce(old.promise).mockResolvedValue({ ok: true, sessions: [summarize("Fresh", session("Fresh").doc)], unreadable: 0 }), pickFolder: vi.fn(async () => "/new-chats") });
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Draft in the old folder" } });
  menu("settings");
  fireEvent.click(screen.getByRole("tab", { name: "Chats" }));
  fireEvent.click(screen.getByRole("button", { name: "Choose" }));
  await screen.findByText("/new-chats");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("button", { name: "Fresh" });
  await act(async () => old.resolve({ ok: true, sessions: [summarize("Old", session("Old").doc)], unreadable: 0 }));
  expect(screen.queryByRole("button", { name: "Old" })).toBeNull();
  expect(api.listSessions).toHaveBeenCalledTimes(2);
  expect(api.setWindowDirty).toHaveBeenLastCalledWith(true);
});

it("retains the draft and dirty report when Send fails before acceptance, including drafts in another chat", async () => {
  const { api, rendered } = await mount();
  const field = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(field, { target: { value: "Keep this prompt" } });
  expect(api.setWindowDirty).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByRole("alert");
  expect(field).toHaveProperty("value", "Keep this prompt");
  fireEvent.click(await screen.findByRole("button", { name: "A" }));
  await waitFor(() => expect(screen.getByTestId("conversation").textContent).toBe("A"));
  expect(api.setWindowDirty).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveProperty("value", "Keep this prompt");
  rendered.unmount();
  expect(api.setWindowDirty).toHaveBeenLastCalledWith(false);
});

it("applies delayed image paste to its original draft and keeps newer text", async () => {
  const paste = deferred<string | null>();
  const { api } = await mount({ pasteImage: vi.fn(() => paste.promise) });
  const field = screen.getByRole("textbox", { name: "Message" });
  fireEvent.paste(field, { clipboardData: { items: [{ kind: "file", type: "image/png" }], files: [] } });
  fireEvent.change(field, { target: { value: "Newer text" } });
  fireEvent.click(await screen.findByRole("button", { name: "A" }));
  await act(async () => paste.resolve("/staged/reference.png"));
  expect(screen.queryByRole("list", { name: "Attached images" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveProperty("value", "Newer text");
  expect(document.querySelector('.chips img')?.getAttribute("src")).toContain("reference.png");
  expect(api.setWindowDirty).toHaveBeenLastCalledWith(true);
});

it("consumes startup restoration once rather than restoring the saved chat on a return to its folder", async () => {
  const boot = bootInfo();
  boot.state.lastSessionId = "A";
  const { api, menu } = await mount({ pickFolder: vi.fn().mockResolvedValueOnce("/other-chats").mockResolvedValueOnce("/chats") }, boot);
  await waitFor(() => expect(screen.getByTestId("conversation").textContent).toBe("A"));
  for (const [root, count] of [["/other-chats", 2], ["/chats", 3]] as const) {
    menu("settings");
    fireEvent.click(screen.getByRole("tab", { name: "Chats" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    await screen.findByText(root);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(count));
    await act(async () => {});
  }
  expect(api.openSession).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("conversation").textContent).toBe("");
});

it("does not restore the startup chat after New was chosen during slow discovery", async () => {
  const list = deferred<{ ok: true } & SessionsListing>();
  const boot = bootInfo();
  boot.state.lastSessionId = "A";
  const { api } = await mount({ listSessions: vi.fn(() => list.promise) }, boot);
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  await act(async () => list.resolve({ ok: true, sessions: [summarize("A", session("A").doc)], unreadable: 0 }));
  expect(api.openSession).not.toHaveBeenCalled();
  expect(screen.getByTestId("conversation").textContent).toBe("");
});

it("keeps an accepted new chat open when startup discovery finishes later", async () => {
  const list = deferred<{ ok: true } & SessionsListing>();
  const pending = deferred<Awaited<ReturnType<GptImgApi["send"]>>>();
  const boot = bootInfo();
  boot.state.lastSessionId = "A";
  let started!: Parameters<GptImgApi["onTurnStarted"]>[0];
  const { api } = await mount({
    listSessions: vi.fn(() => list.promise),
    onTurnStarted: (handler) => { started = handler; return () => {}; },
    send: vi.fn<GptImgApi["send"]>(() => pending.promise),
  }, boot);
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "New work" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  const request = vi.mocked(api.send).mock.calls[0]![0];
  act(() => started({ requestId: request.requestId, session: session("Created") }));
  await act(async () => list.resolve({ ok: true, sessions: [summarize("A", session("A").doc)], unreadable: 0 }));
  expect(api.openSession).not.toHaveBeenCalled();
  expect(screen.getByTestId("conversation").textContent).toBe("Created");
  expect(screen.getByRole("button", { name: "A" })).toBeTruthy();
  await act(async () => pending.resolve({ ok: true, session: session("Created") }));
});

it("updates the one changed chat in the rail without listing the folder again", async () => {
  let emit: (change: SessionChange) => void = () => {};
  const { api } = await mount({ onSessionsChanged: (handler) => { emit = handler; return () => {}; } });
  await screen.findByRole("button", { name: "A" });
  const renamed = summarize("A2", { ...session("A").doc, title: "Renamed" });
  await act(async () => emit({ kind: "entry", id: "A", session: renamed }));
  expect(screen.queryByRole("button", { name: "A" })).toBeNull();
  await act(async () => emit({ kind: "entry", id: "B", session: null }));
  await act(async () => emit({ kind: "entry", id: "C", session: summarize("C", { ...session("C").doc, createdAt: "2026-10-24T00:00:00.000Z" }) }));
  expect(screen.getAllByRole("button").filter((b) => b.closest("nav")).map((b) => b.textContent)).toEqual(["New chat", "C", "Renamed"]);
  expect(api.listSessions).toHaveBeenCalledOnce();
});
