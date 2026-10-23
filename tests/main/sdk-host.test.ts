import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SdkHost } from "../../src/main/sdk-host.ts";

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("electron", () => ({ utilityProcess: { fork } }));

class Child extends EventEmitter {
  postMessage = vi.fn();
  kill = vi.fn(() => true);
}
const app = { name: "test", version: "1" };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("SdkHost", () => {
  let child: Child;
  let onExit: ReturnType<typeof vi.fn<(code: number) => void>>;
  let host: SdkHost;
  beforeEach(() => {
    vi.useFakeTimers();
    fork.mockReset();
    child = new Child();
    fork.mockReturnValue(child);
    onExit = vi.fn();
    host = new SdkHost("/worker.js", onExit);
  });
  afterEach(() => { vi.useRealTimers(); });

  it("settles an unsent cancellation locally without dispatching paid work", async () => {
    const call = host.call("chat", app, {});
    const other = host.call("chat", app, {});
    call.cancel();
    await expect(call.done).resolves.toMatchObject({
      kind: "error", error: { name: "GptImgError", code: "cancelled", kind: "cancelled", effect: "none" },
    });
    expect(child.postMessage).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    child.emit("message", { type: "ready" });
    await flush();
    expect(child.postMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "call", id: other.id }));
    expect(vi.getTimerCount()).toBe(0);
    child.emit("message", { type: "result", id: other.id, result: { ok: true } });
    await expect(other.done).resolves.toEqual({ kind: "result", result: { ok: true } });
    await expect(call.done).resolves.toMatchObject({ kind: "error", error: { code: "cancelled" } });
  });

  it("keeps sent cancellation pending until the worker actually settles", async () => {
    const call = host.call("chat", app, {});
    child.emit("message", { type: "ready" });
    await flush();
    const settled = vi.fn();
    void call.done.then(settled);
    call.cancel();
    await flush();
    expect(settled).not.toHaveBeenCalled();
    expect(child.postMessage.mock.calls.map(([message]) => message.type)).toEqual(["call", "cancel"]);
    child.emit("message", { type: "error", id: call.id, error: { code: "cancelled", effect: "unknown" } });
    await expect(call.done).resolves.toEqual({ kind: "error", error: { code: "cancelled", effect: "unknown" } });
  });

  it.each(["call", "cancel"])("settles a throwing %s post as lost and keeps the failed child owned", async (throwingType) => {
    const call = host.call("chat", app, {});
    child.postMessage.mockImplementation((message) => {
      if (message.type === throwingType) throw new Error("channel closed");
    });
    child.emit("message", { type: "ready" });
    await flush();
    if (throwingType === "cancel") expect(() => call.cancel()).not.toThrow();
    await expect(call.done).resolves.toEqual({ kind: "lost" });
    expect(child.kill).toHaveBeenCalledOnce();
    // Neither a new call nor a late ready message revives a broken channel.
    child.emit("message", { type: "ready" });
    await expect(host.call("chat", app, {}).done).resolves.toEqual({ kind: "lost" });
    expect(fork).toHaveBeenCalledOnce();
    child.emit("exit", 1);
    const replacement = new Child();
    fork.mockReturnValue(replacement);
    const next = host.call("chat", app, {});
    replacement.emit("message", { type: "ready" });
    await flush();
    replacement.emit("message", { type: "result", id: next.id, result: { ok: true } });
    await expect(next.done).resolves.toEqual({ kind: "result", result: { ok: true } });
    expect(fork).toHaveBeenCalledTimes(2);
  });

  it("retains other dispatched work until exit when a later post fails", async () => {
    const first = host.call("chat", app, {});
    child.emit("message", { type: "ready" });
    await flush();
    const settled = vi.fn();
    void first.done.then(settled);
    child.postMessage.mockImplementation(() => { throw new Error("channel closed"); });
    await expect(host.call("chat", app, {}).done).resolves.toEqual({ kind: "lost" });
    expect(settled).not.toHaveBeenCalled();
    child.emit("exit", 1);
    await expect(first.done).resolves.toEqual({ kind: "lost" });
  });

  it("settles a fork exception as lost and allows later lazy startup", async () => {
    fork.mockImplementationOnce(() => { throw new Error("fork failed"); });
    await expect(host.call("chat", app, {}).done).resolves.toEqual({ kind: "lost" });
    const next = host.call("chat", app, {});
    child.emit("message", { type: "ready" });
    await flush();
    expect(fork).toHaveBeenCalledTimes(2);
    child.emit("exit", 1);
    await expect(next.done).resolves.toEqual({ kind: "lost" });
  });

  it("bounds readiness, kills its child, and retains ownership until exit", async () => {
    const call = host.call("chat", app, {});
    await vi.advanceTimersByTimeAsync(29_999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(call.done).resolves.toEqual({ kind: "lost" });
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit("message", { type: "ready" });
    await expect(host.call("chat", app, {}).done).resolves.toEqual({ kind: "lost" });
    expect(child.postMessage).not.toHaveBeenCalled();
    expect(fork).toHaveBeenCalledOnce();
    child.emit("exit", 1);
    expect(onExit).toHaveBeenCalledWith(1);
    expect(vi.getTimerCount()).toBe(0);
    host.call("chat", app, {});
    expect(fork).toHaveBeenCalledTimes(2);
    child.emit("exit", 0);
  });

  it("settles all pending calls on exit exactly once", async () => {
    const first = host.call("chat", app, {});
    const second = host.call("chat", app, {});
    const settled = vi.fn();
    void first.done.then(settled);
    child.emit("message", { type: "ready" });
    await flush();
    child.emit("exit", 7);
    child.emit("message", { type: "result", id: first.id, result: {} });
    await expect(first.done).resolves.toEqual({ kind: "lost" });
    await expect(second.done).resolves.toEqual({ kind: "lost" });
    expect(settled).toHaveBeenCalledOnce();
    expect(onExit).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears readiness wait when the worker exits before ready", async () => {
    const call = host.call("chat", app, {});
    child.emit("exit", 2);
    await expect(call.done).resolves.toEqual({ kind: "lost" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.postMessage).not.toHaveBeenCalled();
  });

  it("delivers hooks and settles a reply once, ignoring later replies", async () => {
    const hooks = { onEvent: vi.fn(), onProgress: vi.fn(), onPartial: vi.fn() };
    const call = host.call("chat", app, {}, hooks);
    child.emit("message", { type: "ready" });
    await flush();
    child.emit("message", { type: "event", id: call.id, event: { event: "one" } });
    child.emit("message", { type: "progress", id: call.id, progress: { done: 1 } });
    child.emit("message", { type: "partial", id: call.id, partial: { id: "one" } });
    child.emit("message", { type: "error", id: call.id, error: { code: "failed" } });
    child.emit("message", { type: "result", id: call.id, result: {} });
    child.emit("message", { type: "event", id: call.id, event: {} });
    await expect(call.done).resolves.toEqual({ kind: "error", error: { code: "failed" } });
    expect(hooks.onEvent).toHaveBeenCalledOnce();
    expect(hooks.onProgress).toHaveBeenCalledOnce();
    expect(hooks.onPartial).toHaveBeenCalledOnce();
  });

  it("restarts only after exit and reports later unexpected exits", async () => {
    const call = host.call("chat", app, {});
    child.emit("message", { type: "ready" });
    await flush();
    const settled = vi.fn();
    void call.done.then(settled);
    const staleExit = child.listeners("exit")[0]!;
    const restart = host.restart();
    const restarted = vi.fn();
    void restart.then(restarted);
    await flush();
    expect(settled).not.toHaveBeenCalled();
    expect(restarted).not.toHaveBeenCalled();
    await expect(host.call("chat", app, {}).done).resolves.toEqual({ kind: "lost" });
    expect(fork).toHaveBeenCalledOnce();
    child.emit("exit", 0);
    await restart;
    await expect(call.done).resolves.toEqual({ kind: "lost" });
    expect(onExit).not.toHaveBeenCalled();
    const replacement = new Child();
    fork.mockReturnValue(replacement);
    const next = host.call("chat", app, {});
    replacement.emit("message", { type: "ready" });
    await flush();
    child.emit("message", { type: "result", id: next.id, result: { stale: true } });
    staleExit(9);
    replacement.emit("message", { type: "result", id: next.id, result: { fresh: true } });
    await expect(next.done).resolves.toEqual({ kind: "result", result: { fresh: true } });
    replacement.emit("exit", 3);
    expect(onExit).toHaveBeenCalledExactlyOnceWith(3);
  });

  it("retains pending work and prevents overlap after restart timeout", async () => {
    const call = host.call("chat", app, {});
    child.emit("message", { type: "ready" });
    await flush();
    const settled = vi.fn();
    void call.done.then(settled);
    const restarting = host.restart();
    const rejected = expect(restarting).rejects.toThrow("did not exit within 30 seconds");
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(settled).not.toHaveBeenCalled();
    await expect(host.call("chat", app, {}).done).resolves.toEqual({ kind: "lost" });
    expect(fork).toHaveBeenCalledOnce();
    expect(child.postMessage).toHaveBeenCalledOnce();
    child.emit("exit", 0);
    await expect(call.done).resolves.toEqual({ kind: "lost" });
    const replacement = new Child();
    fork.mockReturnValue(replacement);
    const next = host.call("chat", app, {});
    expect(fork).toHaveBeenCalledTimes(2);
    replacement.emit("exit", 1);
    await expect(next.done).resolves.toEqual({ kind: "lost" });
  });

  it("stop kills only the owned child and settles work at exit", async () => {
    const call = host.call("chat", app, {});
    child.emit("message", { type: "ready" });
    await flush();
    const settled = vi.fn();
    void call.done.then(settled);
    host.stop();
    await flush();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    child.emit("exit", 0);
    await expect(call.done).resolves.toEqual({ kind: "lost" });
    expect(onExit).not.toHaveBeenCalled();
  });
});
