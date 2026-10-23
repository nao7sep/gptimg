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
  it("retires a borrowed generation while independent new work and lazy reuse continue", async () => {
    const entered = deferred();
    const finish = deferred();
    native.create.mockImplementation(async () => ({ run: async () => ({}), release: native.release }));
    const operation = withSession("/models/a.onnx", undefined, async (session) => {
      entered.resolve();
      await finish.promise;
      return runSession(session, {});
    });
    await entered.promise;
    const release = releaseSessions();
    try {
      const next = await withSession("/models/a.onnx", undefined, async (session) => session);
      const cached = await withSession("/models/a.onnx", undefined, async (session) => session);
      expect(cached).toBe(next);
      expect(native.create).toHaveBeenCalledTimes(2);
      expect(native.release).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await operation;
      expect(await release).toBe(1);
    }
  });

  it("shares a concurrent disposal and releases other sessions even when one disposal fails", async () => {
    const disposing = deferred();
    const finish = deferred();
    const cause = new Error("cannot release a");
    const releaseA = vi.fn(async (): Promise<void> => { disposing.resolve(); await finish.promise; throw cause; });
    native.create.mockImplementation(async (path: string) => ({ release: path.endsWith("a") ? releaseA : native.release }));
    await withSession("/models/a", undefined, async () => {});
    await withSession("/models/b", undefined, async () => {});
    const first = releaseSessions();
    const second = releaseSessions();
    const results = Promise.allSettled([first, second]);
    await disposing.promise;
    expect(releaseA).toHaveBeenCalledOnce();
    finish.resolve();
    expect((await results).map((result) => result.status)).toEqual(["rejected", "rejected"]);
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
