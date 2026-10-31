// @vitest-environment jsdom
// Stepping a splitter with the keyboard is continuous editing: the width shows
// at every step and is saved once, a short delay after the last step, each step
// pushing the save back; leaving the splitter saves a waiting width at once.
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Rail } from "../../src/renderer/src/components/Rail.tsx";
import { RecordsWindow } from "../../src/renderer/src/records/RecordsWindow.tsx";
import { bootInfo, fakeApi, renderInApp } from "./harness.tsx";

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const press = (name: string, key: string, times = 1) => {
  for (let i = 0; i < times; i++) fireEvent.keyDown(screen.getByRole("separator", { name }), { key });
};

describe("keyboard splitters", () => {
  it("saves the chat list's width once the stepping pauses", async () => {
    fakeApi();
    const onWidth = vi.fn();
    // The app keeps the saved width and hands it back, as App does.
    function Owner() {
      const [width, setWidth] = useState(240);
      return (
        <Rail chats={[]} currentId="" running={{}} refused={[]} failure={null} chatsDir="/chats" timeZone="UTC" width={width}
          onWidth={(next) => { onWidth(next); setWidth(next); }}
          onNew={() => {}} onOpen={() => {}} onRename={() => {}} onTrash={() => {}} mac onMenu={() => {}} />
      );
    }
    await renderInApp(() => <Owner />);
    press("Resize the chat list", "ArrowRight", 3);
    expect(screen.getByRole("separator", { name: "Resize the chat list" }).getAttribute("aria-valuenow")).toBe("264");
    await act(async () => vi.advanceTimersByTime(400));
    press("Resize the chat list", "ArrowRight");
    await act(async () => vi.advanceTimersByTime(400));
    expect(onWidth).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(100));
    expect(onWidth).toHaveBeenCalledExactlyOnceWith(272);
    press("Resize the chat list", "ArrowLeft");
    fireEvent.blur(screen.getByRole("separator", { name: "Resize the chat list" }));
    expect(onWidth).toHaveBeenLastCalledWith(264);
  });

  it("saves the record list's width once the stepping pauses", async () => {
    const api = fakeApi({ onRecordsChanged: () => () => {}, onChatsChanged: () => () => {}, onSettings: () => () => {} });
    const boot = bootInfo();
    boot.state.recordsListWidth = 400;
    await renderInApp(() => <RecordsWindow boot={boot} />);
    press("Resize the record list", "ArrowRight", 5);
    expect(api.saveRecordsLayout).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(500));
    expect(api.saveRecordsLayout).toHaveBeenCalledExactlyOnceWith(480);
  });
});
