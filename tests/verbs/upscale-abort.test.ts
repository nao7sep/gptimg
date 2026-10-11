import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GptImg } from "../../src/index.js";

// Substitute only the managed-model and native-session edges. The public verb,
// RGB packing/tiling, alpha resampling and file publication all run for real.
const model = vi.hoisted(() => ({
  ensureModel: vi.fn(),
  loadSession: vi.fn(),
  run: vi.fn(),
}));

vi.mock("../../src/local/models/fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/local/models/fetch.js")>()),
  ensureModel: model.ensureModel,
}));
vi.mock("../../src/local/models/session.js", () => ({ loadSession: model.loadSession }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function session() {
  return { inputNames: ["pixel_values"], outputNames: ["reconstruction"], run: model.run };
}

function reconstruction() {
  const plane = 32 * 32;
  const data = new Float32Array(3 * plane);
  data.fill(0.8, 0, plane);
  data.fill(0.2, plane, 2 * plane);
  data.fill(0.4, 2 * plane);
  return { reconstruction: { data, dims: [1, 3, 32, 32] } };
}

describe("public upscale cancellation at model boundaries", () => {
  let tmp: string;
  let input: string;
  let sdk: GptImg;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-upscale-abort-"));
    sdk = new GptImg({ profileDir: tmp, logDir: tmp });
    input = path.join(tmp, "input.png");
    const rgba = new Uint8Array(8 * 8 * 4);
    for (let p = 0; p < 8 * 8; p++) {
      rgba.set([204, 51, 102, p % 8 < 4 ? 0 : 255], p * 4);
    }
    await sharp(Buffer.from(rgba), { raw: { width: 8, height: 8, channels: 4 } }).png().toFile(input);
    model.ensureModel.mockReset().mockResolvedValue("/nonexistent/swin2sr.onnx");
    model.loadSession.mockReset().mockResolvedValue(session());
    model.run.mockReset().mockImplementation(async () => reconstruction());
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function assertNothingPublished() {
    expect((await readdir(tmp)).filter((name) => name.startsWith("upscaled"))).toEqual([]);
  }

  it("does not start native session loading after cancellation during acquisition", async () => {
    const ctrl = new AbortController();
    const entered = deferred<void>();
    const acquired = deferred<string>();
    model.ensureModel.mockImplementation(async () => {
      entered.resolve();
      return acquired.promise;
    });
    const operation = sdk.upscale({ in: input, toSize: 16, outName: "upscaled" }, { signal: ctrl.signal });
    const rejected = expect(operation).rejects.toMatchObject({ name: "AbortError", code: "cancelled" });
    void rejected.catch(() => undefined);
    try {
      await entered.promise;
      ctrl.abort(new Error("stop acquiring"));
      acquired.resolve("/nonexistent/swin2sr.onnx");
      await rejected;
      expect(model.loadSession).not.toHaveBeenCalled();
      expect(model.run).not.toHaveBeenCalled();
      await assertNothingPublished();
    } finally {
      acquired.resolve("/nonexistent/swin2sr.onnx");
      await operation.catch(() => undefined);
    }
  });

  it("reports cancellation before reading incomplete session metadata", async () => {
    const ctrl = new AbortController();
    const entered = deferred<void>();
    const loaded = deferred<ReturnType<typeof session>>();
    model.loadSession.mockImplementation(async () => {
      entered.resolve();
      return loaded.promise;
    });
    const operation = sdk.upscale({ in: input, toSize: 16, outName: "upscaled" }, { signal: ctrl.signal });
    const rejected = expect(operation).rejects.toMatchObject({ name: "AbortError", code: "cancelled" });
    void rejected.catch(() => undefined);
    const incomplete = { inputNames: [], outputNames: [], run: model.run };
    try {
      await entered.promise;
      ctrl.abort(new Error("stop loading"));
      loaded.resolve(incomplete);
      await rejected;
      expect(model.run).not.toHaveBeenCalled();
      await assertNothingPublished();
    } finally {
      loaded.resolve(incomplete);
      await operation.catch(() => undefined);
    }
  });

  it("owns native execution through settlement and publishes no cancelled result", async () => {
    const ctrl = new AbortController();
    const entered = deferred<void>();
    const ran = deferred<ReturnType<typeof reconstruction>>();
    model.run.mockImplementation(async () => {
      entered.resolve();
      return ran.promise;
    });
    const operation = sdk.upscale({ in: input, toSize: 16, outName: "upscaled" }, { signal: ctrl.signal });
    let settled = false;
    void operation.then(() => { settled = true; }, () => { settled = true; });
    const rejected = expect(operation).rejects.toMatchObject({ name: "AbortError", code: "cancelled" });
    void rejected.catch(() => undefined);
    try {
      await entered.promise;
      ctrl.abort(new Error("stop inference"));
      // In-flight native work is not interruptible. Its completed pixels are
      // discarded when control returns to the cancellable image pipeline.
      await assertNothingPublished();
      expect(settled).toBe(false);
      ran.resolve(reconstruction());
      await rejected;
      expect(model.run).toHaveBeenCalledOnce();
      await assertNothingPublished();
    } finally {
      ran.resolve(reconstruction());
      await operation.catch(() => undefined);
    }
  });

  it("publishes the public success result with resampled alpha without model weights", async () => {
    const result = await sdk.upscale({ in: input, toSize: 16, kernel: "nearest", outName: "upscaled" });
    expect(result).toMatchObject({
      input,
      output: path.join(tmp, "upscaled.png"),
      sourceWidth: 8,
      sourceHeight: 8,
      modelWidth: 32,
      modelHeight: 32,
      width: 16,
      height: 16,
      tiles: 1,
      kernel: "nearest",
    });
    expect(model.ensureModel).toHaveBeenCalledOnce();
    expect(model.loadSession).toHaveBeenCalledOnce();
    expect(model.run).toHaveBeenCalledOnce();
    const { data, info } = await sharp(result.output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([16, 16]);
    expect(data[3]).toBe(0);
    expect(Array.from(data.subarray(12 * 4, 13 * 4))).toEqual([204, 51, 102, 255]);
  });
});
