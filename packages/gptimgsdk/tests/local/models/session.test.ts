import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const ortMocks = vi.hoisted(() => ({
  create: vi.fn(async () => ({ run: vi.fn() })),
}));

vi.mock("onnxruntime-node", () => ({
  InferenceSession: { create: ortMocks.create },
}));

import { loadSession } from "../../../src/local/models/session.ts";

describe("managed ONNX sessions", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    ortMocks.create.mockClear();
  });

  it("suppresses native warning output while preserving typed failures", async () => {
    await loadSession("/tmp/gptimg-session-warning-threshold.onnx");

    expect(ortMocks.create).toHaveBeenCalledWith(
      "/tmp/gptimg-session-warning-threshold.onnx",
      expect.objectContaining({ logSeverityLevel: 3 }),
    );
  });

  it("shares one creation among concurrent first callers", async () => {
    const modelPath = "/tmp/gptimg-session-concurrent.onnx";
    const sessions = await Promise.all(Array.from({ length: 5 }, () => loadSession(modelPath)));

    expect(ortMocks.create).toHaveBeenCalledOnce();
    expect(new Set(sessions).size).toBe(1);
  });

  it("forgets a failed creation so the next call tries again", async () => {
    const modelPath = "/tmp/gptimg-session-retry.onnx";
    ortMocks.create.mockRejectedValueOnce(new Error("corrupt weights"));

    await expect(loadSession(modelPath)).rejects.toMatchObject({ code: "model.loadFailed" });
    await expect(loadSession(modelPath)).resolves.toBeDefined();
    expect(ortMocks.create).toHaveBeenCalledTimes(2);
  });

  it("uses the CPU provider and half the cores unless the environment overrides them", async () => {
    vi.stubEnv("GPTIMG_ONNX_EP", undefined);
    vi.stubEnv("GPTIMG_ONNX_INTRA_OP_THREADS", undefined);
    await loadSession("/tmp/gptimg-session-defaults.onnx");

    expect(ortMocks.create).toHaveBeenLastCalledWith(
      "/tmp/gptimg-session-defaults.onnx",
      expect.objectContaining({
        executionProviders: ["cpu"],
        intraOpNumThreads: Math.max(1, Math.floor(os.cpus().length / 2)),
      }),
    );
  });

  it("reads a provider list and thread count from the environment", async () => {
    vi.stubEnv("GPTIMG_ONNX_EP", " CoreML , ,cpu ");
    vi.stubEnv("GPTIMG_ONNX_INTRA_OP_THREADS", "3");
    await loadSession("/tmp/gptimg-session-overrides.onnx");

    expect(ortMocks.create).toHaveBeenLastCalledWith(
      "/tmp/gptimg-session-overrides.onnx",
      expect.objectContaining({ executionProviders: ["coreml", "cpu"], intraOpNumThreads: 3 }),
    );
  });

  it("falls back to CPU when the provider override lists nothing", async () => {
    vi.stubEnv("GPTIMG_ONNX_EP", " , ");
    vi.stubEnv("GPTIMG_ONNX_INTRA_OP_THREADS", undefined);
    await loadSession("/tmp/gptimg-session-empty-ep.onnx");

    expect(ortMocks.create).toHaveBeenLastCalledWith(
      "/tmp/gptimg-session-empty-ep.onnx",
      expect.objectContaining({ executionProviders: ["cpu"] }),
    );
  });

  it.each(["0", "-2", "1.5", "many"])("refuses a thread override of %j before loading the model", async (value) => {
    vi.stubEnv("GPTIMG_ONNX_EP", undefined);
    vi.stubEnv("GPTIMG_ONNX_INTRA_OP_THREADS", value);

    await expect(loadSession(`/tmp/gptimg-session-bad-threads-${value}.onnx`)).rejects.toMatchObject({
      code: "model.loadFailed",
      message: expect.stringContaining("GPTIMG_ONNX_INTRA_OP_THREADS"),
    });
    expect(ortMocks.create).not.toHaveBeenCalled();
  });
});
