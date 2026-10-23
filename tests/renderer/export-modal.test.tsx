// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpscalerStatus } from "../../src/shared/api.ts";
import { defaultExportPrefs } from "../../src/shared/export.ts";
import { fakeApi, renderInApp } from "./harness.tsx";

afterEach(cleanup);

async function open(status?: UpscalerStatus) {
  const api = fakeApi(status ? { upscalerStatus: vi.fn(async () => status) } : {});
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


it("shows a model check failure without suggesting a download, while ordinary export remains usable", async () => {
  const { api } = await open({ installed: false, downloadBytes: null, failure: { message: { key: "failure.filePermission" }, retryable: true } });
  expect(screen.getByRole("button", { name: "Export" })).toHaveProperty("disabled", false);
  fireEvent.click(screen.getByRole("radio", { name: /AI upscale 2×/ }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "GptImg is not allowed to read or write a file this message needs.");
  expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  expect(screen.queryByText(/one-time download/)).toBeNull();
  expect(screen.getByRole("button", { name: "Export" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("radio", { name: /Original size/ }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Export" })).toHaveProperty("disabled", false);
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() => expect(api.exportImage).toHaveBeenCalledTimes(1));
  expect(api.installUpscaler).not.toHaveBeenCalled();
});

it("enables upscale export for a present model without suggesting a download", async () => {
  await open({ installed: true, downloadBytes: 53_827_735 });
  fireEvent.click(screen.getByRole("radio", { name: /AI upscale 2×/ }));
  expect(screen.getByRole("button", { name: "Export" })).toHaveProperty("disabled", false);
  expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
});
