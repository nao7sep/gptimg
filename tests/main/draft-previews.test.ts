import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftPreviews } from "../../src/main/draft-previews.ts";
import type { PartialDraft } from "../../src/main/sdk-protocol.ts";

const fs = vi.hoisted(() => ({
  mkdir: vi.fn<(...args: unknown[]) => Promise<void>>(),
  writeFile: vi.fn<(path: string, data: Uint8Array, options: unknown) => Promise<void>>(),
  rm: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));
vi.mock("node:fs/promises", () => fs);

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function draft(index: number, format = "png"): PartialDraft {
  return { image: 0, index, data: new Uint8Array([index]), format };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("DraftPreviews", () => {
  beforeEach(() => {
    fs.mkdir.mockResolvedValue(undefined);
    fs.writeFile.mockResolvedValue(undefined);
    fs.rm.mockResolvedValue(undefined);
  });
  afterEach(() => { vi.resetAllMocks(); });

  it("writes a chat's previews one after another in the order they arrive", async () => {
    const first = gate();
    fs.writeFile.mockImplementation((_path, bytes) => bytes[0] === 1 ? first.promise : Promise.resolve());
    const publish = vi.fn();
    const previews = new DraftPreviews("/staging", publish);
    const old = previews.show("chat", draft(1));
    const latest = previews.show("chat", draft(2));
    await flush();
    expect(fs.writeFile).toHaveBeenCalledOnce();
    const oldPath = fs.writeFile.mock.calls[0]![0];
    first.resolve();
    await old;
    await latest;
    const latestPath = fs.writeFile.mock.calls[1]![0];
    expect(publish.mock.calls).toEqual([["chat", oldPath], ["chat", latestPath]]);
    expect(fs.rm).toHaveBeenCalledExactlyOnceWith(oldPath, { force: true });
  });

  it("clears after a preview whose write is pending, removing that preview", async () => {
    const writing = gate();
    fs.writeFile.mockReturnValue(writing.promise);
    const publish = vi.fn();
    const previews = new DraftPreviews("/staging", publish);
    const pending = previews.show("chat", draft(1));
    const cleared = previews.show("chat", null);
    await flush();
    const path = fs.writeFile.mock.calls[0]![0];
    writing.resolve();
    await pending;
    await cleared;
    expect(publish.mock.calls).toEqual([["chat", path], ["chat", null]]);
    expect(fs.rm).toHaveBeenCalledExactlyOnceWith(path, { force: true });
  });

  it("removes the previous published file on replacement and the current file on clear", async () => {
    const publish = vi.fn();
    const previews = new DraftPreviews("/staging", publish);
    await previews.show("chat", draft(1));
    const previous = publish.mock.calls[0]![1];
    await previews.show("chat", draft(2, "jpeg"));
    const current = publish.mock.calls[1]![1];
    expect(current).toMatch(/^\/staging\/draft-.*\.jpg$/);
    expect(fs.rm).toHaveBeenCalledExactlyOnceWith(previous, { force: true });
    await previews.show("chat", null);
    expect(publish.mock.calls).toEqual([["chat", previous], ["chat", current], ["chat", null]]);
    expect(fs.rm.mock.calls).toEqual([[previous, { force: true }], [current, { force: true }]]);
  });

  it("cleans up a failed write and retains the previous published preview", async () => {
    const publish = vi.fn();
    const previews = new DraftPreviews("/staging", publish);
    await previews.show("chat", draft(1));
    const previous = publish.mock.calls[0]![1];
    fs.writeFile.mockRejectedValueOnce(new Error("write failed"));
    fs.rm.mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(previews.show("chat", draft(2))).resolves.toBeUndefined();
    const failed = fs.writeFile.mock.calls[1]![0];
    expect(publish).toHaveBeenCalledExactlyOnceWith("chat", previous);
    expect(fs.rm).toHaveBeenCalledExactlyOnceWith(failed, { force: true });
    await previews.show("chat", null);
    expect(fs.rm).toHaveBeenLastCalledWith(previous, { force: true });
  });

  it("keeps different chats independent when one is cleared", async () => {
    const publish = vi.fn();
    const previews = new DraftPreviews("/staging", publish);
    await previews.show("one", draft(1));
    await previews.show("two", draft(2));
    const secondPath = publish.mock.calls[1]![1];
    await previews.show("one", null);
    expect(fs.rm).not.toHaveBeenCalledWith(secondPath, { force: true });
    expect(publish).not.toHaveBeenCalledWith("two", null);
  });
});
