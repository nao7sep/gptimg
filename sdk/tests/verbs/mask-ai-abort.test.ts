import { mkdtemp, readdir, rm } from "node:fs/promises";
import { done } from "../helpers/results.ts";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GptImg } from "../../src/index.ts";

// A stand-in model on disk and session, so cancellation around inference is
// exercised without downloading BiRefNet.
const model = vi.hoisted(() => ({
  loadSession: vi.fn(),
  run: vi.fn(),
}));

vi.mock("../../src/local/models/fetch.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/local/models/fetch.ts")>()),
  requireInstalledModel: vi.fn(() => "/nonexistent/birefnet.onnx"),
}));

vi.mock("../../src/local/models/session.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/local/models/session.ts")>()),
  loadSession: model.loadSession,
}));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INPUT = path.resolve(HERE, "..", "fixtures", "green-disk.png");
const SIZE = 1024;

function fakeSession() {
  return {
    inputNames: ["input"],
    outputNames: ["output"],
    run: model.run,
  };
}

describe("mask (ai) cancellation around inference", () => {
  let tmp: string;
  let sdk: GptImg;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-mask-ai-abort-"));
    sdk = new GptImg({ modelsDir: path.join(tmp, "models") });
    model.loadSession.mockReset();
    model.run.mockReset();
    model.run.mockImplementation(async () => ({
      output: { data: new Float32Array(SIZE * SIZE).fill(10), dims: [1, 1, SIZE, SIZE] },
    }));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("stops before inference when cancelled while the session loads", async () => {
    const ctrl = new AbortController();
    model.loadSession.mockImplementation(async () => {
      ctrl.abort();
      return fakeSession();
    });

    await expect(
      sdk.mask({ in: INPUT, method: "ai", outDir: tmp, outName: "cut" }, { signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(model.run).not.toHaveBeenCalled();
    expect((await readdir(tmp)).filter((name) => name.startsWith("cut"))).toEqual([]);
  });

  it("publishes nothing when cancelled during inference", async () => {
    const ctrl = new AbortController();
    model.loadSession.mockResolvedValue(fakeSession());
    model.run.mockImplementation(async () => {
      ctrl.abort();
      return { output: { data: new Float32Array(SIZE * SIZE).fill(10), dims: [1, 1, SIZE, SIZE] } };
    });

    await expect(
      sdk.mask({ in: INPUT, method: "ai", outDir: tmp, outName: "cut" }, { signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(model.run).toHaveBeenCalledOnce();
    expect((await readdir(tmp)).filter((name) => name.startsWith("cut"))).toEqual([]);
  });

  it.each([
    ["model.infer.start"],
    ["model.infer.done"],
  ] as const)("honors cancellation at %s, before publication", async (name) => {
    const ctrl = new AbortController();
    model.loadSession.mockResolvedValue(fakeSession());
    await expect(sdk.mask(
      { in: INPUT, method: "ai", outDir: tmp, outName: "cut" },
      { signal: ctrl.signal, onEvent: (event) => { if (event.event === name) ctrl.abort(); } },
    )).rejects.toMatchObject({ code: "cancelled" });
    expect(model.run).toHaveBeenCalledTimes(name === "model.infer.start" ? 0 : 1);
    expect((await readdir(tmp)).filter((name) => name.startsWith("cut"))).toEqual([]);
  });

  it("still publishes when not cancelled", async () => {
    model.loadSession.mockResolvedValue(fakeSession());

    const result = done(await sdk.mask({ in: INPUT, method: "ai", outDir: tmp, outName: "cut" }));
    expect(result.output).toBe(path.join(tmp, "cut.png"));
  });
});
