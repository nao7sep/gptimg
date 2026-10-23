// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Modal, requestTopModalClose } from "../../src/renderer/src/modals/Modal.tsx";
import { ViewerModal } from "../../src/renderer/src/modals/ViewerModal.tsx";
import { fakeApi, renderInApp } from "./harness.tsx";

afterEach(cleanup);

describe("Shared modal boundary", () => {
  it("contains viewer focus and restores the trigger on close", async () => {
    fakeApi();
    function Surface() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Open viewer</button>{open && <ViewerModal images={["/a.png"]} index={0} onClose={() => setOpen(false)} onExport={vi.fn()} />}</>;
    }
    await renderInApp(() => <Surface />);
    const trigger = screen.getByRole("button", { name: "Open viewer" });
    trigger.focus();
    fireEvent.click(trigger);
    const close = screen.getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab" });
    const copy = screen.getByRole("button", { name: "Copy" });
    expect(document.activeElement).toBe(copy);
    fireEvent.keyDown(copy, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(close);
    trigger.focus();
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
    expect(requestTopModalClose()).toBe(false);
    expect(document.body.style.overflow).toBe("");
  });

  it("menu dismissal and Escape reach only the top dialog, with focus returning underneath", async () => {
    fakeApi();
    const outerClose = vi.fn();
    function Surface() {
      const [child, setChild] = useState(false);
      return <Modal title="Parent" width={400} onClose={outerClose}><button onClick={() => setChild(true)}>Open child</button>{child && <Modal title="Child" width={400} onClose={() => setChild(false)}><button data-autofocus="true">Keep editing</button></Modal>}</Modal>;
    }
    await renderInApp(() => <Surface />);
    const trigger = screen.getByRole("button", { name: "Open child" });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("button", { name: "Keep editing" }), { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
    expect(outerClose).not.toHaveBeenCalled();
    const parent = screen.getByRole("dialog", { name: "Parent" });
    parent.focus();
    fireEvent.keyDown(parent, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(trigger);
    expect(requestTopModalClose()).toBe(true);
    expect(outerClose).toHaveBeenCalledOnce();
  });
});

it("restores a usable background control when the viewer invoker was removed", async () => {
  fakeApi();
  function Surface() {
    const [open, setOpen] = useState(false);
    return <><button>New chat</button>{!open && <button onClick={() => setOpen(true)}>Open removed image</button>}{open && <ViewerModal images={["/a.png"]} index={0} onClose={() => setOpen(false)} onExport={vi.fn()} />}</>;
  }
  await renderInApp(() => <Surface />);
  const trigger = screen.getByRole("button", { name: "Open removed image" });
  trigger.focus();
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole("button", { name: "Close" }), { key: "Escape" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "New chat" }));
});
