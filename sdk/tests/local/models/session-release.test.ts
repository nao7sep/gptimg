import { afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ create: vi.fn(), release: vi.fn() }));
vi.mock("onnxruntime-node", () => ({ InferenceSession: { create: native.create } }));
import { withSession, releaseSessions, runSession } from "../../../src/local/models/session.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(async () => {
  native.release.mockResolvedValue(undefined);
  await releaseSessions();
  vi.resetAllMocks();
});

describe("releasing loaded models", () => {
  it("releases once the operation ahead of it settles, and the next operation loads again", async () => {
    const entered = deferred();
    const finish = deferred();
    const order: string[] = [];
    native.release.mockImplementation(async () => { order.push("release"); });
    native.create.mockImplementation(async () => ({ run: async () => { order.push("run"); return {}; }, release: native.release }));
    const operation = withSession("/models/a.onnx", undefined, async (session) => {
      entered.resolve();
      await finish.promise;
      return runSession(session, {});
    });
    await entered.promise;
    const release = releaseSessions();
    const next = withSession("/models/a.onnx", undefined, async (session) => session);
    finish.resolve();
    await operation;
    expect(await release).toBe(1);
    const reloaded = await next;
    expect(await withSession("/models/a.onnx", undefined, async (session) => session)).toBe(reloaded);
    expect(order).toEqual(["run", "release"]);
    expect(native.create).toHaveBeenCalledTimes(2);
  });

  it("releases other sessions when one disposal fails, and keeps the failed one for a later release", async () => {
    const cause = new Error("cannot release a");
    const releaseA = vi.fn(async (): Promise<void> => { throw cause; });
    native.create.mockImplementation(async (path: string) => ({ release: path.endsWith("a") ? releaseA : native.release }));
    await withSession("/models/a", undefined, async () => {});
    await withSession("/models/b", undefined, async () => {});
    await expect(releaseSessions()).rejects.toMatchObject({ code: "internal.unexpected", effect: "unknown", cause });
    expect(releaseA).toHaveBeenCalledOnce();
    expect(native.release).toHaveBeenCalledOnce();
    releaseA.mockResolvedValue(undefined);
    expect(await releaseSessions()).toBe(1);
    expect(releaseA).toHaveBeenCalledTimes(2);
    expect(native.release).toHaveBeenCalledOnce();
  });

  it("treats failed creation separately from disposal failure", async () => {
    const started = deferred();
    const finish = deferred();
    native.create.mockImplementationOnce(async () => { started.resolve(); await finish.promise; throw new Error("bad model"); });
    const operation = withSession("/models/bad", undefined, async () => {});
    const failure = expect(operation).rejects.toMatchObject({ code: "model.loadFailed" });
    await started.promise;
    const release = releaseSessions();
    finish.resolve();
    await failure;
    expect(await release).toBe(0);
    expect(native.release).not.toHaveBeenCalled();
  });
});
