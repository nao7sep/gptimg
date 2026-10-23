import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Ort from "onnxruntime-node";

const native = vi.hoisted(() => ({ create: vi.fn(), run: vi.fn(), release: vi.fn(), tensor: vi.fn() }));
vi.mock("onnxruntime-node", () => ({
  InferenceSession: { create: native.create },
  Tensor: class {
    readonly type: string;
    readonly data: Float32Array;
    readonly dims: number[];
    constructor(type: string, data: Float32Array, dims: number[]) {
      this.type = type;
      this.data = data;
      this.dims = dims;
      native.tensor();
    }
  },
}));
vi.mock("../../../src/local/models/fetch.ts", () => ({
  requireInstalledModel: (_entry: unknown, key: string, dir: string) => `${dir}/${key}.onnx`,
}));
vi.mock("../../../src/local/models/registry.ts", async (original) => {
  const registry = await original<typeof import("../../../src/local/models/registry.ts")>();
  return { ...registry, BIREFNET: { ...registry.BIREFNET, inputSize: 8 } };
});

import { GptImg } from "../../../src/index.ts";
import { runBirefnet } from "../../../src/local/models/birefnet.ts";
import { runSwin2srX4 } from "../../../src/local/models/swin2sr.ts";
import { releaseSessions } from "../../../src/local/models/session.ts";
import type { Logger } from "../../../src/events/index.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function session() {
  return { inputNames: ["input"], outputNames: ["output"], run: native.run, release: native.release };
}

function output(feeds: Ort.InferenceSession.FeedsType) {
  const input = feeds.input!;
  const height = input.dims[2]! * 4;
  const width = input.dims[3]! * 4;
  return { output: { data: new Float32Array(height * width * 3), dims: [1, 3, height, width] } };
}

afterEach(async () => {
  native.release.mockResolvedValue(undefined);
  await releaseSessions();
  vi.resetAllMocks();
});

describe("operation-scoped native session ownership", () => {
  it("keeps a loading BiRefNet borrow through preprocessing and inference", async () => {
    const loading = deferred<void>();
    const ready = deferred<ReturnType<typeof session>>();
    const order: string[] = [];
    native.create.mockImplementation(async () => { loading.resolve(); return ready.promise; });
    native.release.mockImplementation(async () => { order.push("release"); });
    native.run.mockImplementation(async () => {
      order.push("run");
      return { output: { data: new Float32Array(64), dims: [1, 1, 8, 8] } };
    });
    const operation = runBirefnet(new Uint8Array(8 * 8 * 4), 8, 8, "/loading");
    await loading.promise;
    const release = new GptImg().model.release();
    ready.resolve(session());
    await operation;
    expect(await release).toMatchObject({ status: "completed", released: 1 });
    expect(order).toEqual(["run", "release"]);
  });

  it("keeps a loaded BiRefNet session when release starts in preprocessing before its native run", async () => {
    native.create.mockResolvedValue(session());
    const entered = deferred<void>();
    const finish = deferred<void>();
    let release: Promise<number> | undefined;
    native.tensor.mockImplementationOnce(() => { release = releaseSessions(); });
    native.run.mockImplementation(async () => {
      entered.resolve();
      await finish.promise;
      return { output: { data: new Float32Array(64), dims: [1, 1, 8, 8] } };
    });
    const operation = runBirefnet(new Uint8Array(8 * 8 * 4), 8, 8, "/preprocessing");
    try {
      await entered.promise;
      expect(native.release).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await operation;
      expect(await release).toBe(1);
    }
  });

  it("does not dispose between tiles or during a later run admitted after release begins", async () => {
    native.create.mockResolvedValue(session());
    let release: Promise<number> | undefined;
    const enteredSecond = deferred<void>();
    const finishSecond = deferred<void>();
    native.run.mockImplementationOnce(async (feeds) => output(feeds));
    native.run.mockImplementationOnce(async (feeds) => {
      enteredSecond.resolve();
      await finishSecond.promise;
      return output(feeds);
    });
    native.run.mockImplementation(async (feeds) => output(feeds));
    const logger = { progress: () => { release ??= releaseSessions(); } } as unknown as Logger;
    const operation = runSwin2srX4(new Uint8Array(129 * 8 * 3), 129, 8, "/tiles", { tile: 128, logger });
    try {
      await enteredSecond.promise;
      expect(native.release).not.toHaveBeenCalled();
    } finally {
      finishSecond.resolve();
      await operation;
      await release;
    }
    expect(native.release).toHaveBeenCalledOnce();
  });

  it("rejects public release on disposal failure and retains ownership for a retry", async () => {
    native.create.mockResolvedValue(session());
    native.run.mockImplementation(async (feeds) => output(feeds));
    await runSwin2srX4(new Uint8Array(8 * 8 * 3), 8, 8, "/retry");
    const cause = new Error("native disposal failed");
    native.release.mockRejectedValueOnce(cause).mockResolvedValue(undefined);
    const sdk = new GptImg();
    await expect(sdk.model.release()).rejects.toMatchObject({ name: "GptImgError", code: "internal.unexpected", effect: "unknown", subject: "/retry/swin2sr.onnx", cause });
    expect(await sdk.model.release()).toMatchObject({ status: "completed", released: 1 });
    expect(native.release).toHaveBeenCalledTimes(2);
    expect(native.create).toHaveBeenCalledOnce();
  });
});
