import { describe, expect, it } from "vitest";
import { GptImg } from "../../src/gptimg.js";
import {
  validateBackplateArgs,
  validateCombineArgs,
  validateComposeArgs,
  validateEditArgs,
  validateGenerateArgs,
  validateIconArgs,
  validateLayerArgs,
  validateMaskArgs,
  validateModelKey,
  validateResizeArgs,
  validateShadowArgs,
  validateTrimArgs,
  validateUpscaleArgs,
  validateVisionArgs,
} from "../../src/verbs/schemas.js";

/** Assert `fn` throws the shared usage error (`args.invalid`), optionally matching a message fragment. */
function badArgs(fn: () => unknown, msg?: string): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err, "expected a throw").toBeTruthy();
  const e = err as { code?: string; errorType?: string; message?: string };
  expect(e.code).toBe("args.invalid");
  expect(e.errorType).toBe("localOp");
  if (msg) expect(e.message).toContain(msg);
}

describe("verb argument validation (single source of truth)", () => {
  it("generate / edit / vision: required fields", () => {
    expect(validateGenerateArgs({ prompt: "a cat" }).prompt).toBe("a cat");
    badArgs(() => validateGenerateArgs({ prompt: "" }), "prompt");
    badArgs(() => validateEditArgs({ prompt: "x", in: "" }), "in");
    expect(validateEditArgs({ prompt: "x", in: "a.png" }).in).toBe("a.png");
    badArgs(() => validateVisionArgs({ in: "a.png", check: "" }), "check");
    badArgs(() => validateVisionArgs({ in: [], check: "ok" }));
    badArgs(() => validateVisionArgs({ in: "", check: "ok" }));
    badArgs(() => validateVisionArgs({ in: ["a.png", ""], check: "ok" }));
    expect(validateVisionArgs({ in: ["a.png", "b.png"], check: "ok" })).toBeTruthy();
  });

  it("mask: method enum, key form, numeric bounds", () => {
    expect(validateMaskArgs({ in: "a.png" })).toBeTruthy();
    expect(validateMaskArgs({ in: "a.png", method: "ai" })).toBeTruthy();
    badArgs(() => validateMaskArgs({ in: "a.png", method: "nope" as never }), "method must be one of");
    badArgs(() => validateMaskArgs({ in: "a.png", key: "green" }), "key must be");
    expect(validateMaskArgs({ in: "a.png", key: "#00ff00" })).toBeTruthy();
    expect(validateMaskArgs({ in: "a.png", key: "from-sidecar" })).toBeTruthy();
    badArgs(() => validateMaskArgs({ in: "a.png", saturationRatio: 5 }), "must be in (0..1]");
    badArgs(() => validateMaskArgs({ in: "a.png", saturationRatio: 0 }), "must be in (0..1]");
    badArgs(() => validateMaskArgs({ in: "a.png", borderSample: 0 }), "positive integer");
  });

  it("compose: required in/mask, hex removeBleed", () => {
    expect(validateComposeArgs({ in: "a.png", mask: "m.png" })).toBeTruthy();
    badArgs(() => validateComposeArgs({ in: "", mask: "m.png" }), "in");
    badArgs(() => validateComposeArgs({ in: "a.png", mask: "m.png", removeBleed: "00ff00" }), "hex");
    expect(validateComposeArgs({ in: "a.png", mask: "m.png", removeBleed: "#00ff00" })).toBeTruthy();
  });

  it("combine: op enum and op-dependent arity", () => {
    expect(validateCombineArgs({ op: "union", inputs: ["a.png", "b.png"] })).toBeTruthy();
    expect(validateCombineArgs({ op: "invert", inputs: ["a.png"] })).toBeTruthy();
    badArgs(() => validateCombineArgs({ op: "nope" as never, inputs: ["a.png"] }), "op must be one of");
    badArgs(() => validateCombineArgs({ op: "union", inputs: ["a.png"] }), "expects exactly 2");
    badArgs(() => validateCombineArgs({ op: "invert", inputs: ["a.png", "b.png"] }), "expects exactly 1");
    badArgs(() => validateCombineArgs({ op: "feather", inputs: ["a.png"], radius: -1 }), "[0..1024]");
    badArgs(() => validateCombineArgs({ op: "feather", inputs: ["a.png"], radius: 1e9 }), "[0..1024]");
  });

  it("trim / backplate: numeric ranges and enums", () => {
    expect(validateTrimArgs({ in: "a.png", margin: 0.5 })).toBeTruthy();
    badArgs(() => validateTrimArgs({ in: "a.png", margin: 2 }), "[0..1]");
    expect(validateBackplateArgs({ from: "#000000", to: "#ffffff" })).toBeTruthy();
    badArgs(() => validateBackplateArgs({ from: "nope", to: "#ffffff" }), "hex");
    badArgs(() => validateBackplateArgs({ to: "#ffffff" } as never), "from"); // from is required
    badArgs(() => validateBackplateArgs({ from: "#000000", to: "#ffffff", angle: Infinity })); // non-finite rejected by z.number()
    badArgs(() => validateBackplateArgs({ from: "#000000", to: "#ffffff", size: 0 }), "positive integer");
    badArgs(() => validateBackplateArgs({ from: "#000000", to: "#ffffff", content: 5 }), "(0..1]");
    badArgs(() => validateBackplateArgs({ from: "#000000", to: "#ffffff", radius: 0.9 }), "[0..0.5]");
    badArgs(() => validateBackplateArgs({ from: "#000000", to: "#ffffff", shape: "blob" as never }), "shape must be one of");
  });

  it("layer / shadow: enums, integer offsets, ranges", () => {
    expect(validateLayerArgs({ base: "b.png", top: "t.png", gravity: "north" })).toBeTruthy();
    badArgs(() => validateLayerArgs({ base: "b.png", top: "t.png", gravity: "middle" as never }), "gravity must be one of");
    badArgs(() => validateLayerArgs({ base: "b.png", top: "t.png", scale: 0 }), "positive number");
    badArgs(() => validateLayerArgs({ base: "b.png", top: "t.png", topOffset: { x: 1.5, y: 2 } }), "integers");
    badArgs(() => validateShadowArgs({ in: "a.png", opacity: 5 }), "(0..1]");
    badArgs(() => validateShadowArgs({ in: "a.png", opacity: Infinity })); // non-finite rejected by z.number()
    badArgs(() => validateShadowArgs({ in: "a.png", opacity: NaN })); // NaN rejected by z.number()
    badArgs(() => validateShadowArgs({ in: "a.png", spread: 1.5 }), "integer");
    badArgs(() => validateShadowArgs({ in: "a.png", spread: 100000 }), "[0..1024]");
    badArgs(() => validateShadowArgs({ in: "a.png", offset: { x: 1.5, y: 0 } }), "offset must be integers");
    badArgs(() => validateShadowArgs({ in: "a.png", offset: { x: 99999, y: 0 } }), "within");
    badArgs(() => validateShadowArgs({ in: "a.png", blur: 0.2 }), "0 or between");
    expect(validateShadowArgs({ in: "a.png", blur: 0 })).toBeTruthy();
  });

  it("upscale / resize: size ranges, kernel enum, tile minimum", () => {
    expect(validateUpscaleArgs({ in: "a.png", kernel: "lanczos3" })).toBeTruthy();
    badArgs(() => validateUpscaleArgs({ in: "a.png", toSize: 0 }), "[1..8192]");
    badArgs(() => validateUpscaleArgs({ in: "a.png", kernel: "bogus" as never }), "kernel must be one of");
    badArgs(() => validateUpscaleArgs({ in: "a.png", tile: 50 }), ">=");
    expect(validateResizeArgs({ in: "a.png", toSize: 512 })).toBeTruthy();
    badArgs(() => validateResizeArgs({ in: "a.png" } as never)); // toSize is required
    badArgs(() => validateResizeArgs({ in: "a.png", toSize: 0 }), "[1..16384]");
    badArgs(() => validateResizeArgs({ in: "a.png", toSize: 99, kernel: "bogus" as never }), "kernel must be one of");
  });

  it("icon: name stem (no path separators)", () => {
    expect(validateIconArgs({ in: "a.png", name: "app" })).toBeTruthy();
    badArgs(() => validateIconArgs({ in: "a.png", name: "sub/app" }), "path separators");
    badArgs(() => validateIconArgs({ in: "a.png", name: "../evil" }), "path separators");
  });

  it("model: key membership (own properties only)", () => {
    expect(() => validateModelKey("birefnet")).not.toThrow();
    badArgs(() => validateModelKey("nope"), "unknown model");
    // Inherited Object.prototype keys must be rejected, not read as an entry.
    badArgs(() => validateModelKey("toString"), "unknown model");
    badArgs(() => validateModelKey("constructor"), "unknown model");
  });

  it("the SDK enforces enums and bounds itself — not just the CLI (§3)", async () => {
    // Calling the SDK directly (the supported, primary surface) with a bad enum
    // or out-of-range value must reject before any I/O — proving the constraint
    // lives in the SDK, not only in the CLI's `.choices()`.
    const sdk = new GptImg();
    await expect(
      sdk.backplate({ from: "#000000", to: "#ffffff", shape: "blob" as never }),
    ).rejects.toMatchObject({ code: "args.invalid" });
    await expect(
      sdk.layer({ base: "b.png", top: "t.png", gravity: "middle" as never }),
    ).rejects.toMatchObject({ code: "args.invalid" });
    await expect(sdk.resize({ in: "a.png", toSize: -1 })).rejects.toMatchObject({
      code: "args.invalid",
    });
    // combine validates through the impl too (op enum + arity), not only via the
    // standalone validator.
    await expect(
      sdk.combine({ op: "nope" as never, inputs: ["a.png"] }),
    ).rejects.toMatchObject({ code: "args.invalid" });
    await expect(
      sdk.combine({ op: "union", inputs: ["only-one.png"] }),
    ).rejects.toMatchObject({ code: "args.invalid" });
  });
});
