import { describe, expect, it } from "vitest";
import { mergePolicies } from "../../src/policy/merge.ts";
import type { Policy } from "../../src/types.ts";

describe("mergePolicies", () => {
  it("returns the base unchanged when no patches are given", () => {
    const base: Policy = { generate: { size: "1024x1024" } };
    expect(mergePolicies(base)).toEqual(base);
  });

  it("applies a single patch, patch winning on overlap", () => {
    const base: Policy = { generate: { size: "old", quality: "high" } };
    const patch: Partial<Policy> = { generate: { size: "new" } };
    const out = mergePolicies(base, patch);
    expect(out.generate?.size).toBe("new");
    expect(out.generate?.quality).toBe("high");
  });

  it("preserves last-wins ordering across multiple patches", () => {
    const base: Policy = { generate: { size: "base", quality: "low" } };
    const p1: Partial<Policy> = { generate: { size: "p1" } };
    const p2: Partial<Policy> = { generate: { size: "p2", quality: "p2q" } };
    const out = mergePolicies(base, p1, p2);
    expect(out.generate?.size).toBe("p2");
    expect(out.generate?.quality).toBe("p2q");
  });

  it("merges nested objects without dropping untouched keys", () => {
    const base: Policy = {
      vision: { shrink: { width: 512, height: 512 } } as Policy["vision"],
    };
    const patch: Partial<Policy> = {
      vision: { shrink: { width: 1024 } } as Policy["vision"],
    };
    const out = mergePolicies(base, patch);
    expect(out.vision?.shrink).toEqual({ width: 1024, height: 512 });
  });

  it("replaces a list whole instead of joining it", () => {
    const base: Policy = { network: { imageGenerate: { retryIntervals: [2, 3], timeout: 60 } } };
    const patch: Partial<Policy> = { network: { imageGenerate: { retryIntervals: [1] } } };
    expect(mergePolicies(base, patch).network).toEqual({ imageGenerate: { retryIntervals: [1], timeout: 60 } });
    expect(base.network).toEqual({ imageGenerate: { retryIntervals: [2, 3], timeout: 60 } });
  });

  it("ignores null/undefined patches", () => {
    const base: Policy = { generate: { n: 1 } };
    const out = mergePolicies(
      base,
      null as unknown as Partial<Policy>,
      undefined as unknown as Partial<Policy>,
    );
    expect(out).toEqual(base);
  });
});

