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

  it("uses the CPU provider and half the cores unless the policy sets them, ignoring the environment", async () => {
    vi.stubEnv("GPTIMG_ONNX_EP", "coreml");
    vi.stubEnv("GPTIMG_ONNX_INTRA_OP_THREADS", "7");
    await loadSession("/tmp/gptimg-session-defaults.onnx");

    expect(ortMocks.create).toHaveBeenLastCalledWith(
      "/tmp/gptimg-session-defaults.onnx",
      expect.objectContaining({
        executionProviders: ["cpu"],
        intraOpNumThreads: Math.max(1, Math.floor(os.cpus().length / 2)),
      }),
    );
  });

  it("takes providers and threads from policy.onnx", async () => {
    await loadSession("/tmp/gptimg-session-overrides.onnx", { executionProviders: ["coreml", "cpu"], intraOpThreads: 3 });

    expect(ortMocks.create).toHaveBeenLastCalledWith(
      "/tmp/gptimg-session-overrides.onnx",
      expect.objectContaining({ executionProviders: ["coreml", "cpu"], intraOpNumThreads: 3 }),
    );
  });

  it("keeps a separate session per tuning of one model", async () => {
    const modelPath = "/tmp/gptimg-session-tunings.onnx";
    const a = await loadSession(modelPath, { intraOpThreads: 1 });
    const b = await loadSession(modelPath, { intraOpThreads: 2 });
    const again = await loadSession(modelPath, { intraOpThreads: 1 });
    expect(ortMocks.create).toHaveBeenCalledTimes(2);
    expect(again).toBe(a);
    expect(b).not.toBe(a);
  });
});
