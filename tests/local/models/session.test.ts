import { afterEach, describe, expect, it, vi } from "vitest";

const ortMocks = vi.hoisted(() => ({
  create: vi.fn(async () => ({ run: vi.fn() })),
}));

vi.mock("onnxruntime-node", () => ({
  InferenceSession: { create: ortMocks.create },
}));

import { loadSession } from "../../../src/local/models/session.js";

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
});
