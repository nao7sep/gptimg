import { describe, expect, it, vi } from "vitest";

const released: string[] = [];
let finishRun: () => void = () => {};
vi.mock("onnxruntime-node", () => ({
  InferenceSession: {
    create: async (path: string) => ({
      run: () => new Promise((resolve) => (finishRun = () => resolve({ out: path }))),
      release: async () => {
        released.push(path);
      },
    }),
  },
  Tensor: class {},
}));

const { loadSession, releaseSessions, runSession } = await import("../../../src/local/models/session.ts");

describe("releasing loaded models", () => {
  it("waits for inference in flight, then frees every loaded session", async () => {
    const session = await loadSession("/models/a.onnx");
    await loadSession("/models/b.onnx");
    const inference = runSession(session, {});
    let done = false;
    const release = releaseSessions().then((n) => {
      done = true;
      return n;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    finishRun();
    await inference;
    expect(await release).toBe(2);
    expect(released.sort()).toEqual(["/models/a.onnx", "/models/b.onnx"]);
    // The next call loads a fresh session.
    expect(await loadSession("/models/a.onnx")).not.toBe(session);
  });
});
