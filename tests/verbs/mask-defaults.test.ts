import { describe, expect, it } from "vitest";
import { applyChromaRecipeDefaults } from "../../src/verbs/mask-defaults.js";
import type { MaskArgs } from "../../src/types.js";

function args(over: Partial<MaskArgs> = {}): MaskArgs {
  return { in: "a.png", ...over };
}

describe("applyChromaRecipeDefaults", () => {
  it("fills every unset field from the recipe", () => {
    const merged = applyChromaRecipeDefaults(args(), {
      color: "#00ff00",
      preserveInterior: true,
      borderSample: 4,
      saturationRatio: 0.5,
    });
    expect(merged.key).toBe("#00ff00");
    expect(merged.preserveInterior).toBe(true);
    expect(merged.borderSample).toBe(4);
    expect(merged.saturationRatio).toBe(0.5);
  });

  it("never overrides an explicitly-passed arg, including a falsy one", () => {
    const merged = applyChromaRecipeDefaults(
      args({ key: "auto", preserveInterior: false, borderSample: 1, saturationRatio: 0.9 }),
      { color: "#00ff00", preserveInterior: true, borderSample: 4, saturationRatio: 0.5 },
    );
    expect(merged.key).toBe("auto");
    expect(merged.preserveInterior).toBe(false);
    expect(merged.borderSample).toBe(1);
    expect(merged.saturationRatio).toBe(0.9);
  });

  it("treats a blank or absent recipe color as no key default", () => {
    expect(applyChromaRecipeDefaults(args(), { color: "" }).key).toBeUndefined();
    expect(applyChromaRecipeDefaults(args(), {}).key).toBeUndefined();
  });

  it("returns a new object without mutating the input args", () => {
    const input = args();
    const merged = applyChromaRecipeDefaults(input, { color: "#abcdef" });
    expect(input.key).toBeUndefined();
    expect(merged).not.toBe(input);
  });
});
