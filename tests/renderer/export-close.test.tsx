// @vitest-environment jsdom
// Closing the Export dialog never stops its work (modal-dialog-conventions): with
// the upscaler download running, Escape, the backdrop, ✕ and Cancel each close the
// dialog the same way, the download goes on and shows in the task strip, and Stop
// is the only way to cancel it.
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { defaultExportPrefs } from "../../src/shared/export.ts";
import { fakeApi, renderInApp } from "./harness.tsx";

afterEach(cleanup);

type Finish = (result: { ok: true } | { ok: false; failure: { message: { key: string }; retryable: boolean } }) => void;

async function openAndDownload() {
  let finish!: Finish;
  const api = fakeApi({ installUpscaler: (() => new Promise((resolve) => (finish = resolve))) as never });
  const { ExportModal } = await import("../../src/renderer/src/modals/ExportModal.tsx");
  const { TaskStrip } = await import("../../src/renderer/src/components/TaskStrip.tsx");
  const { useExportTasks } = await import("../../src/renderer/src/export-tasks.ts");
  function Host() {
    const tasks = useExportTasks();
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          reopen
        </button>
        {open ? (
          <ExportModal path="/chats/c/fox.png" prefs={{ ...defaultExportPrefs(), size: { kind: "upscale", factor: 2 } }} tasks={tasks} onClose={() => setOpen(false)} onExported={() => setOpen(false)} />
        ) : (
          <TaskStrip tasks={tasks} />
        )}
      </>
    );
  }
  await renderInApp(() => <Host />);
  fireEvent.click(await screen.findByRole("button", { name: "Download" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Downloading…"));
  return { api, finish: (result: Parameters<Finish>[0]) => act(async () => finish(result)) };
}

const closePaths: [string, () => void][] = [
  ["Escape", () => fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })],
  ["the backdrop", () => fireEvent.mouseDown(document.querySelector(".scrim")!)],
  ["✕", () => fireEvent.click(screen.getByRole("button", { name: "Close" }))],
  ["Cancel", () => fireEvent.click(screen.getByRole("button", { name: "Cancel" }))],
];

describe("closing the export dialog while the upscaler downloads", () => {
  it.each(closePaths)("%s closes it and leaves the download running, shown outside with Stop", async (_path, close) => {
    const { api, finish } = await openAndDownload();
    close();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.cancelTask).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("Downloading the upscaling model…");
    await finish({ ok: true });
    expect(screen.getByRole("status").textContent).toContain("The upscaling model was downloaded.");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("stops the download only through Stop, outside the dialog or in it", async () => {
    const { api, finish } = await openAndDownload();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(api.cancelTask).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(api.cancelTask).toHaveBeenCalledTimes(2);
    await finish({ ok: false, failure: { message: { key: "failure.cancelled" }, retryable: true } });
    // A stopped download leaves nothing to report.
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the running download again when the dialog is reopened, and a failure that came while it was closed", async () => {
    const { finish } = await openAndDownload();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "reopen" }));
    expect(screen.getByRole("status").textContent).toContain("Downloading…");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await finish({ ok: false, failure: { message: { key: "failure.unreachable" }, retryable: true } });
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});
