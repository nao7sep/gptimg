// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootInfo, fakeApi, renderInApp } from "./harness.tsx";

afterEach(cleanup);

async function open(onClose = vi.fn(), onSaved = vi.fn(), onDirtyChange = vi.fn()) {
  const api = fakeApi();
  const boot = bootInfo();
  const { SettingsModal } = await import("../../src/renderer/src/modals/SettingsModal.tsx");
  const rendered = await renderInApp(() => <SettingsModal boot={boot} settings={boot.settings} problem={null} keyStatus={boot.key} onClose={onClose} onSaved={onSaved} onDirtyChange={onDirtyChange} />);
  return { api, onClose, onSaved, onDirtyChange, rendered };
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

describe("Settings drafts and partial saves", () => {
  it("keeps a blank numeric draft dirty and invalid across tabs until reset", async () => {
    const { api, onClose } = await open();
    fireEvent.change(screen.getByLabelText("Conversation text size"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Conversation text size").getAttribute("aria-invalid")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Chats" }));
    fireEvent.click(screen.getByRole("tab", { name: "General" }));
    expect(screen.getByLabelText("Conversation text size")).toHaveProperty("value", "");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Discard changes?")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset fonts" }));
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it("publishes saved settings even when the key fails, retaining the key draft for retry", async () => {
    const { api, onClose, onSaved } = await open();
    vi.mocked(api.setKey).mockResolvedValueOnce({ ok: false, failure: { retryable: true, message: { key: "failure.internal" } } });
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    fireEvent.click(screen.getByRole("tab", { name: "OpenAI" }));
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-new-draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("alert");
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ theme: "dark" }), expect.objectContaining({ source: "stored" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("API key")).toHaveProperty("value", "sk-new-draft");
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(api.setKey).toHaveBeenNthCalledWith(2, "sk-new-draft");
  });
});


it("reports invalid numeric draft dirtiness and clears it only on reset or unmount", async () => {
  const { onDirtyChange, rendered } = await open();
  expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  fireEvent.change(screen.getByLabelText("Conversation text size"), { target: { value: "" } });
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  const calls = onDirtyChange.mock.calls.length;
  fireEvent.change(screen.getByLabelText("Conversation text size"), { target: { value: "20" } });
  expect(onDirtyChange.mock.calls.slice(calls).some(([dirty]) => dirty === false)).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Reset fonts" }));
  expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  rendered.unmount();
  expect(onDirtyChange).toHaveBeenLastCalledWith(false);
});
