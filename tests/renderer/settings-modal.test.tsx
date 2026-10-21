// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootInfo, fakeApi, renderInApp } from "./harness.tsx";

afterEach(cleanup);

async function open(onClose = vi.fn(), onSaved = vi.fn()) {
  const api = fakeApi();
  const boot = bootInfo();
  const { SettingsModal } = await import("../../src/renderer/src/modals/SettingsModal.tsx");
  await renderInApp(() => <SettingsModal boot={boot} settings={boot.settings} problem={null} keyStatus={boot.key} onClose={onClose} onSaved={onSaved} />);
  return { api, onClose, onSaved };
}

describe("Settings", () => {
  it("browses from the current folder, then the draft, and saves only when confirmed", async () => {
    const { api, onSaved } = await open();
    const picked = "/pictures/$LITERAL/%COLLECTION%";
    vi.mocked(api.pickFolder).mockResolvedValueOnce(picked).mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole("tab", { name: "Chats" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    await screen.findByText(picked);
    expect(api.pickFolder).toHaveBeenNthCalledWith(1, "/chats");
    expect(api.saveSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    await waitFor(() => expect(api.pickFolder).toHaveBeenNthCalledWith(2, picked));
    expect(screen.getByText(picked)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ sessionsDir: picked }));
  });

  it("leaves the saved folder unchanged when the picker is cancelled or its draft is discarded", async () => {
    const { api, onClose } = await open();
    fireEvent.click(screen.getByRole("tab", { name: "Chats" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    await waitFor(() => expect(api.pickFolder).toHaveBeenCalledWith("/chats"));
    expect(screen.getByText("/chats")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    vi.mocked(api.pickFolder).mockResolvedValueOnce("/other/chats");
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    await screen.findByText("/other/chats");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it("offers Save only after a change, and saves the draft", async () => {
    const { api, onSaved } = await open();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(save).toHaveProperty("disabled", false);
    fireEvent.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ theme: "dark" }));
  });

  it("asks before closing with unsaved changes", async () => {
    const { onClose } = await open();
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Discard changes?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("never shows the saved key, and clears it only when asked", async () => {
    const { api, onSaved } = await open();
    fireEvent.click(screen.getByRole("tab", { name: "OpenAI" }));
    const field = screen.getByLabelText("API key") as HTMLInputElement;
    expect(field.value).toBe("");
    expect(await screen.findByPlaceholderText("A key is saved")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear the saved key" }));
    expect(screen.getByText("The saved key will be cleared when you save.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.clearKey).toHaveBeenCalled();
    expect(api.setKey).not.toHaveBeenCalled();
  });
});
