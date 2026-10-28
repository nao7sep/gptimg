import { mkdtemp, readdir, rm } from "node:fs/promises";
import { done } from "../helpers/results.ts";
import { cancelledError } from "../../src/errors.ts";
import path from "node:path";
import { tmpdir } from "node:os";
import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GptImg, GptImgError } from "../../src/index.ts";
import type { ModelEntry } from "../../src/local/models/registry.ts";

const native = vi.hoisted(() => ({ create: vi.fn(), run: vi.fn() }));

// Keep the actual session cache, tensors and image pipelines. Only acquisition
// and the native create/run edges are substituted, so peers really share a session.
vi.mock("onnxruntime-node", async (importOriginal) => ({
  ...(await importOriginal<typeof import("onnxruntime-node")>()),
  InferenceSession: { create: native.create },
}));
vi.mock("../../src/local/models/fetch.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/local/models/fetch.ts")>()),
  requireInstalledModel: (entry: ModelEntry, _key: string, modelsDir: string) => path.join(modelsDir, entry.name),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function nativeOutput(feeds: ort.InferenceSession.FeedsType): ort.InferenceSession.ReturnType {
  const input = feeds.input!;
  if (input.dims[2] === 1024) {
    return { output: new ort.Tensor("float32", new Float32Array(64).fill(10), [1, 1, 8, 8]) };
  }
  const height = input.dims[2]! * 4;
  const width = input.dims[3]! * 4;
  return {
    output: new ort.Tensor("float32", new Float32Array(3 * height * width).fill(0.5), [1, 3, height, width]),
  };
}

describe.each(["mask", "upscale"] as const)("native execution through public %s", (verb) => {
  let tmp: string;
  let input: string;
  let sdk: GptImg;

  beforeEach(async () => {
    vi.stubEnv("GPTIMG_ONNX_INTRA_OP_THREADS", undefined);
    vi.stubEnv("GPTIMG_ONNX_EP", undefined);
    vi.stubEnv("GPTIMG_MODELS_DIR", undefined);
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-native-run-"));
    sdk = new GptImg({ modelsDir: path.join(tmp, "models") });
    input = path.join(tmp, "input.png");
    await sharp({ create: { width: 8, height: 8, channels: 4, background: "#446688" } }).png().toFile(input);
    native.create.mockReset().mockImplementation(async () => ({
      inputNames: ["input"],
      outputNames: ["output"],
      run: native.run,
    }));
    native.run.mockReset().mockImplementation(async (feeds: ort.InferenceSession.FeedsType) => nativeOutput(feeds));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tmp, { recursive: true, force: true });
  });

  function call(outName: string, signal?: AbortSignal) {
    const options = { signal };
    return verb === "mask"
      ? sdk.mask({ in: input, method: "ai", outName }, options)
      : sdk.upscale({ in: input, toSize: 16, kernel: "nearest", outName }, options);
  }

  async function assertPublished(outcome: Awaited<ReturnType<typeof call>>, outName: string) {
    const result = done(outcome);
    expect(result.output).toBe(path.join(tmp, `${outName}.png`));
    const { data, info } = await sharp(result.output!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual(verb === "mask" ? [8, 8] : [16, 16]);
    expect(Array.from(data.subarray(0, 4))).toEqual(verb === "mask" ? [255, 255, 255, 255] : [128, 128, 128, 255]);
  }

  it("types a native run failure without poisoning the peer that waits its turn or later cached reuse", async () => {
    const entered = deferred();
    const released = deferred();
    const cause = new Error("native operation failed");
    native.run.mockImplementationOnce(async () => {
      entered.resolve();
      await released.promise;
      throw cause;
    });
    const operation = call("failed");
    const rejected = expect(operation).rejects.toMatchObject({
      name: "GptImgError",
      code: "model.runFailed",
      cause,
    });
    void rejected.catch(() => undefined);
    try {
      await entered.promise;
      const peer = call("peer");
      released.resolve();
      await rejected;
      await assertPublished(await peer, "peer");
      expect(native.create).toHaveBeenCalledOnce();
      const failure = await operation.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(GptImgError);
      expect((failure as Error).cause).toBe(cause);
      await assertPublished(await call("later"), "later");
      expect(native.create).toHaveBeenCalledOnce();
      expect(native.run).toHaveBeenCalledTimes(3);
      expect((await readdir(tmp)).filter((name) => name.startsWith("failed"))).toEqual([]);
    } finally {
      released.resolve();
      await operation.catch(() => undefined);
    }
  });

  it.each([
    new GptImgError("model.outputShape", "already classified"),
    cancelledError("native cancellation"),
  ])("preserves the identity of a typed failure or cancellation: %s", async (error) => {
    native.run.mockRejectedValueOnce(error);
    await expect(call("rejected")).rejects.toBe(error);
    expect((await readdir(tmp)).filter((name) => name.startsWith("rejected"))).toEqual([]);
  });

  it.each([
    Object.assign(new Error("native cancellation"), { name: "AbortError" }),
    Object.assign(new Error("native cancellation"), { code: "ABORT_ERR" }),
    Object.assign(new Error("native cancellation"), { code: "ERR_ABORTED" }),
  ])("turns a native abort into the SDK's cancellation with the original as cause: %s", async (error) => {
    native.run.mockRejectedValueOnce(error);
    await expect(call("rejected")).rejects.toMatchObject({ name: "GptImgError", code: "cancelled", cause: error });
    expect((await readdir(tmp)).filter((name) => name.startsWith("rejected"))).toEqual([]);
  });

  it("retains ownership until native settlement, with the peer after it, and cancellation discards only its result", async () => {
    const ctrl = new AbortController();
    const reason = cancelledError("stop this run");
    const entered = deferred();
    const released = deferred();
    native.run.mockImplementationOnce(async (feeds: ort.InferenceSession.FeedsType) => {
      entered.resolve();
      await released.promise;
      return nativeOutput(feeds);
    });
    const operation = call("cancelled", ctrl.signal);
    let settled = false;
    void operation.then(() => { settled = true; }, () => { settled = true; });
    const rejected = expect(operation).rejects.toBe(reason);
    void rejected.catch(() => undefined);
    try {
      await entered.promise;
      ctrl.abort(reason);
      const peer = call("peer");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(native.run).toHaveBeenCalledOnce();
      released.resolve();
      await rejected;
      await assertPublished(await peer, "peer");
      await assertPublished(await call("later"), "later");
      expect(native.create).toHaveBeenCalledOnce();
      expect(native.run).toHaveBeenCalledTimes(3);
      expect((await readdir(tmp)).filter((name) => name.startsWith("cancelled"))).toEqual([]);
    } finally {
      released.resolve();
      await operation.catch(() => undefined);
    }
  });
});
