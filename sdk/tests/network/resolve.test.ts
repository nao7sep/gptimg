import { validatePolicy } from "../../src/policy/schemas.ts";
import { describe, expect, it } from "vitest";
import { NETWORK_DEFAULTS } from "../../src/network/defaults.ts";
import { resolveNetworkConfig } from "../../src/network/resolve.ts";

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

  it.each([
    ["a negative retry count", { maxRetries: -1 }],
    ["a fractional retry count", { maxRetries: 0.5 }],
    ["a disabled timeout", { timeout: 0 }],
    ["a timeout longer than a timer can hold", { timeout: 2_147_000_001 }],
    ["more retries than the cap", { maxRetries: 11 }],
    ["a non-numeric retry interval", { retryIntervals: [1, "bad"] }],
    ["an unknown field", { retries: 3 }],
  ])("refuses %s in policy.network before any request", (_label, budget) => {
    expect(() => validatePolicy({ network: { modelDownload: budget as never } })).toThrow(
      expect.objectContaining({ code: "policy.invalid", details: expect.objectContaining({ section: "network" }) }),
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
