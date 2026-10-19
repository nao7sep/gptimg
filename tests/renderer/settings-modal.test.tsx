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
