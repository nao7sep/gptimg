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
});
