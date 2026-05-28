import { describe, expect, it } from "vitest";
import { NETWORK_DEFAULTS } from "../../src/network/defaults.js";
import { resolveNetworkConfig } from "../../src/network/resolve.js";

describe("resolveNetworkConfig", () => {
  it("returns defaults when nothing is provided", () => {
    const cfg = resolveNetworkConfig(undefined);
    expect(cfg).toEqual(NETWORK_DEFAULTS);
  });

  it("recipe values override defaults per leaf", () => {
    const cfg = resolveNetworkConfig({
      imageGenerate: { timeout: 9999 },
    });
    expect(cfg.imageGenerate.timeout).toBe(9999);
    expect(cfg.imageGenerate.maxRetries).toBe(
      NETWORK_DEFAULTS.imageGenerate.maxRetries,
    );
    expect(cfg.imageGenerate.retryIntervals).toEqual(
      NETWORK_DEFAULTS.imageGenerate.retryIntervals,
    );
  });

  it("replaces arrays rather than concatenating", () => {
    const cfg = resolveNetworkConfig({
      imageGenerate: { retryIntervals: [99] },
    });
    expect(cfg.imageGenerate.retryIntervals).toEqual([99]);
  });

  it("each category resolves independently", () => {
    const cfg = resolveNetworkConfig({
      imageVision: { timeout: 1500 },
    });
    expect(cfg.imageVision.timeout).toBe(1500);
    expect(cfg.imageGenerate.timeout).toBe(NETWORK_DEFAULTS.imageGenerate.timeout);
    expect(cfg.imageDownload.timeout).toBe(NETWORK_DEFAULTS.imageDownload.timeout);
  });

  it("ignores malformed fields and falls back to defaults", () => {
    const cfg = resolveNetworkConfig({
      imageGenerate: {
        timeout: "not a number" as unknown as number,
        maxRetries: -3,
        retryIntervals: [1, "bad" as unknown as number, 3],
      },
    });
    expect(cfg.imageGenerate.timeout).toBe(
      NETWORK_DEFAULTS.imageGenerate.timeout,
    );
    expect(cfg.imageGenerate.maxRetries).toBe(
      NETWORK_DEFAULTS.imageGenerate.maxRetries,
    );
    expect(cfg.imageGenerate.retryIntervals).toEqual(
      NETWORK_DEFAULTS.imageGenerate.retryIntervals,
    );
  });

  it("accepts maxRetries=0 and retryIntervals=[]", () => {
    const cfg = resolveNetworkConfig({
      imageDownload: { maxRetries: 0, retryIntervals: [] },
    });
    expect(cfg.imageDownload.maxRetries).toBe(0);
    expect(cfg.imageDownload.retryIntervals).toEqual([]);
  });
});
