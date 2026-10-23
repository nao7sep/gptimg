// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenedSession } from "../../src/shared/api.ts";
import type { SessionDoc } from "../../src/shared/session.ts";
import { fakeApi, renderInApp } from "./harness.tsx";

afterEach(cleanup);

const at = "2026-10-19T06:00:00.000Z";
const usage = { input: 1, output: 1 };
const doc: SessionDoc = {
  format: 1,
  id: "chat-1",
  title: "Foxes",
  createdAt: at,
  turns: [
    { id: "u1", role: "user", at, text: "a fox like this", images: ["inputs/photo.png"], options: { size: "auto", quality: "low" } },
    { id: "a1", role: "assistant", at, text: "", images: ["t2.png"], responseId: "r1", resumed: null, incomplete: null, usage, failedImages: 0 },
    { id: "u2", role: "user", at, text: "make it blue", images: ["t2.png"], options: { size: "auto", quality: "low" } },
    { id: "a2", role: "assistant", at, text: "", images: ["t4-1.png", "t4-2.png"], responseId: "r2", resumed: "chain", incomplete: null, usage, failedImages: 0 },
  ],
};
const session: OpenedSession = { id: "folder", doc, dir: "/chats/folder" };

describe("the images pane", () => {
  it("lists every image of the chat once, newest first, and tells attached ones from made ones", async () => {
    const { paneImages } = await import("../../src/renderer/src/components/ImagesPane.tsx");
    expect(paneImages(session).map((i) => [i.path, i.attached])).toEqual([
      ["t4-2.png", false],
      ["t4-1.png", false],
      ["t2.png", true],
      ["inputs/photo.png", true],
    ]);
    expect(paneImages(session)[0]!.absolute).toBe("/chats/folder/t4-2.png");
  });

  it("attaches an image on click and takes it off on a second click", async () => {
    fakeApi();
    const { ImagesPane, paneImages } = await import("../../src/renderer/src/components/ImagesPane.tsx");
    const { useState } = await import("react");
    const toggled = vi.fn();
    function Host() {
      const [chosen, setChosen] = useState<Set<string>>(new Set());
      return (
        <ImagesPane
          images={paneImages(session)}
          chosen={chosen}
          onToggle={(image) => {
            toggled(image.path);
            setChosen((c) => {
              const next = new Set(c);
              if (next.has(image.path)) next.delete(image.path);
              else next.add(image.path);
              return next;
            });
          }}
        />
      );
    }
    await renderInApp(() => <Host />);
    const thumbs = screen.getAllByRole("button");
    expect(thumbs).toHaveLength(4);
    expect(thumbs[0]!.getAttribute("aria-label")).toBe("An image the assistant made");
    expect(thumbs[3]!.getAttribute("aria-label")).toBe("An image you attached");
    fireEvent.click(thumbs[1]!);
    expect(thumbs[1]!.getAttribute("aria-pressed")).toBe("true");
    expect(thumbs[1]!.getAttribute("title")).toBe("Remove from the next message");
    fireEvent.click(thumbs[1]!);
    expect(thumbs[1]!.getAttribute("aria-pressed")).toBe("false");
    expect(toggled.mock.calls.map((c) => c[0])).toEqual(["t4-1.png", "t4-1.png"]);
  });

  it("says what it is for while the chat has no images", async () => {
    fakeApi();
    const { ImagesPane } = await import("../../src/renderer/src/components/ImagesPane.tsx");
    await renderInApp(() => <ImagesPane images={[]} chosen={new Set()} onToggle={() => {}} />);
    expect(screen.getByText("Images you make or attach in this chat appear here.")).toBeTruthy();
  });
});

describe("the conversation's notes", () => {
  beforeEach(() => {
    // All four short fixture turns fit in this transcript viewport.
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(1200);
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("says which images were blocked or missing, which message the assistant never saw, and what a mask limited", async () => {
    fakeApi();
    const { Conversation } = await import("../../src/renderer/src/components/Conversation.tsx");
    const turns: SessionDoc["turns"] = [
      { id: "u1", role: "user", at, text: "three portraits", images: [], options: { size: "auto", quality: "low" } },
      { id: "a1", role: "assistant", at, text: "", images: ["t2.png"], responseId: "r1", resumed: null, incomplete: null, usage, failedImages: 0, blockedImages: 2, missingImages: 1 },
      { id: "u2", role: "user", at, text: "add a hat", images: [], options: { size: "auto", quality: "low" } },
      { id: "u3", role: "user", at, text: "a scarf instead", images: ["t2.png"], mask: "inputs/mask.png", options: { size: "auto", quality: "low" } },
    ];
    await renderInApp(() => (
      <Conversation
        session={{ id: "folder", dir: "/chats/folder", doc: { ...doc, turns } }}
        openFailure={null}
        running={null}
        failure={null}
        timeZone="UTC"
        onCancel={() => {}}
        onRetry={() => {}}
        onDismissFailure={() => {}}
        onRename={() => {}}
        onReveal={() => {}}
        imagesPane
        onToggleImagesPane={() => {}}
        onView={() => {}}
        onReuse={() => {}}
        onExport={() => {}}
        exported={null}
      />
    ));
    expect(screen.getByText("OpenAI's safety system blocked 2 images.")).toBeTruthy();
    expect(screen.getByText("OpenAI didn't return the image.")).toBeTruthy();
    expect(screen.getAllByText("This message got no reply, so the assistant doesn't know about it.")).toHaveLength(1);
    expect(screen.getByText("Only the painted area of the first image could change.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show or hide images" }).getAttribute("aria-pressed")).toBe("true");
  });
});
