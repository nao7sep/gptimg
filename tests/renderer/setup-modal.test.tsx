// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupModal } from "../../src/renderer/src/modals/SetupModal.tsx";
import { bootInfo, fakeApi, renderInApp } from "./harness.tsx";

afterEach(cleanup);

describe("first-run chats folder", () => {
  it("offers the document suggestion and preserves its draft when Browse is cancelled", async () => {
    const api = fakeApi();
    const boot = bootInfo();
    boot.settings.chatsDir = "";
    const onDone = vi.fn();
    await renderInApp(() => <SetupModal boot={boot} settings={boot.settings} keyStatus={boot.key} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip for Now" }));
    expect(screen.getByText(boot.suggestedChatsDir)).toBeTruthy();
    const chosen = "/collections/$LITERAL";
    vi.mocked(api.pickFolder).mockResolvedValueOnce(chosen).mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    await screen.findByText(chosen);
    expect(api.pickFolder).toHaveBeenNthCalledWith(1, boot.suggestedChatsDir);
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    await waitFor(() => expect(api.pickFolder).toHaveBeenNthCalledWith(2, chosen));
    expect(screen.getByText(chosen)).toBeTruthy();
    expect(api.saveSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use This Folder" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ chatsDir: chosen }));
  });
});
