// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultExportPrefs } from "../../src/shared/export.ts";
import { fakeApi, renderInApp } from "./harness.tsx";

afterEach(cleanup);

async function open() {
  const api = fakeApi();
  const { ExportModal } = await import("../../src/renderer/src/modals/ExportModal.tsx");
  const { useExportTasks } = await import("../../src/renderer/src/export-tasks.ts");
  const onExported = vi.fn();
  function Host() {
    return <ExportModal path="/chats/c/fox.png" prefs={defaultExportPrefs()} tasks={useExportTasks()} onClose={() => {}} onExported={onExported} />;
  }
  await renderInApp(() => <Host />);
  await screen.findByText("PNG, 2 MB");
  return { api, onExported };
}

describe("the export dialog", () => {
  it("fills transparency for JPEG and exports what was chosen", async () => {
    const { api, onExported } = await open();
    fireEvent.click(screen.getByRole("radio", { name: "JPEG" }));
    expect(screen.getByText("JPEG cannot keep transparency, so transparent areas are filled.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(onExported).toHaveBeenCalled());
    expect(api.exportImage).toHaveBeenCalledWith(expect.objectContaining({ format: "jpeg", path: "/chats/c/fox.png", size: { kind: "original" } }), "fox.jpg");
  });

  it("asks to download the upscaler before an AI upscale, and only on the user's click", async () => {
    const { api } = await open();
    fireEvent.click(screen.getByRole("radio", { name: /AI upscale 2×/ }));
    expect(await screen.findByText(/one-time download of about 53\.8 MB/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export" })).toHaveProperty("disabled", true);
    expect(api.installUpscaler).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(api.installUpscaler).toHaveBeenCalledTimes(1));
  });
});
