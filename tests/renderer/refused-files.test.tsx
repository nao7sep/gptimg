// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GptImgApi } from "../../src/shared/api.ts";
import { Rail } from "../../src/renderer/src/components/Rail.tsx";
import { StartupFailureView } from "../../src/renderer/src/StartupFailure.tsx";
import { App } from "../../src/renderer/src/App.tsx";
import { bootInfo, fakeApi, language, renderInApp } from "./harness.tsx";

afterEach(cleanup);

describe("refused files", () => {
  it("name every file a stopped launch refused, with why and what to do", async () => {
    fakeApi();
    await renderInApp(() => (
      <StartupFailureView
        failure={{
          language,
          message: { key: "startup.refused" },
          refused: [{ path: "/data/config.json", reason: "unreadable" }, { path: "/data/state.json", reason: "newer" }],
          detail: "",
        }}
      />
    ));
    expect(screen.getByText("GptImg found files it cannot open, so it stopped without changing anything:")).toBeTruthy();
    expect(screen.getByText("/data/config.json could not be read.")).toBeTruthy();
    expect(screen.getByText("/data/state.json was saved by a newer version of GptImg.")).toBeTruthy();
    expect(screen.getByText(/move it somewhere else to start fresh/)).toBeTruthy();
    expect(screen.queryByText("Details")).toBeNull();
  });

  it("name each refused chat folder in the rail", async () => {
    fakeApi();
    await renderInApp(() => (
      <Rail chats={[]} currentId="" running={{}} failure={null} chatsDir="/chats" timeZone="UTC" width={240}
        refused={[{ folder: "20261001-000000-utc-Old", reason: "unreadable" }, { folder: "20261002-000000-utc-Later", reason: "newer" }]}
        onWidth={() => {}} onNew={() => {}} onOpen={() => {}} onRename={() => {}} onTrash={() => {}} mac onMenu={() => {}} />
    ));
    expect(screen.getByText("20261001-000000-utc-Old holds no chat GptImg can read.")).toBeTruthy();
    expect(screen.getByText("20261002-000000-utc-Later was saved by a newer version of GptImg.")).toBeTruthy();
  });

  it("show a records or backups store left off for the session", async () => {
    fakeApi({ listChats: vi.fn<GptImgApi["listChats"]>(async () => ({ ok: true, chats: [], refused: [] })), onTurnDraft: () => () => {}, saveState: vi.fn(), setWindowDirty: vi.fn() });
    await renderInApp(() => <App boot={{ ...bootInfo(), storeNotices: [{ key: "notice.recordsOff", values: { path: "/data/records-store.sqlite3" } }] }} />);
    expect(screen.getByRole("status").textContent).toBe("Records are off for this session: /data/records-store.sqlite3 could not be read and was left as it is.");
  });
});
