import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GptImg } from "../../src/gptimg.ts";
import {
  validateBackplateArgs,
  validateCombineArgs,
  validateComposeArgs,
  validateDespeckleArgs,
  validateEditArgs,
  validateEncodeArgs,
  validateFramecheckArgs,
  validateGenerateArgs,
  validateGridArgs,
  validateIconArgs,
  validateKeycheckArgs,
  validateLayerArgs,
  validateMaskArgs,
  validateModelKey,
  validateResizeArgs,
  validateShadowArgs,
  validateTrimArgs,
  validateUpscaleArgs,
  validateVisionArgs,
} from "../../src/verbs/schemas.ts";

/** Assert `fn` throws the shared usage error (`args.invalid`), optionally matching a message fragment. */
function badArgs(fn: () => unknown, msg?: string): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err, "expected a throw").toBeTruthy();
  const e = err as { code?: string; kind?: string; message?: string; details?: { field?: string } };
  expect(e.code).toBe("args.invalid");
  expect(e.kind).toBe("invalid");
  expect(typeof e.details?.field).toBe("string");
  if (msg) expect(e.message).toContain(msg);
}

describe("verb argument validation (single source of truth)", () => {
  it("refuses every relative path argument, naming the field", () => {
    badArgs(() => validateResizeArgs({ in: "a.png", toSize: 8 }), "in must be an absolute path");
    badArgs(() => validateGenerateArgs({ outDir: "output", prompt: "x" }), "outDir must be an absolute path");
    badArgs(() => validateLayerArgs({ base: "/x/b.png", top: "t.png" }), "top must be an absolute path");
    badArgs(() => validateGridArgs({ inputs: ["/x/a.png", "b.png"] }), "inputs[1] must be an absolute path");
    badArgs(() => validateVisionArgs({ in: ["/x/a.png", "b.png"], check: "c" }), "in[1] must be an absolute path");
  });

  it("refuses arguments earlier versions took instead of silently ignoring them", () => {
    badArgs(() => validateGenerateArgs({ outDir: "/x", prompt: "x", overrides: {} } as never), "overrides is now policy");
    badArgs(() => validateGenerateArgs({ outDir: "/x", prompt: "x", recipe: "/r.json" } as never), "recipe files are retired");
    badArgs(() => validateMaskArgs({ in: "/x/a.png", dryRun: true } as never), "no longer has dryRun");
    badArgs(() => validateResizeArgs({ in: "/x/a.png", toSize: 8, log: "/l.log" } as never), "the SDK writes no log");
  });

  it("generate / edit / vision: required fields", () => {
    expect(validateGenerateArgs({ outDir: "/x/output", prompt: "a cat" }).prompt).toBe("a cat");
    badArgs(() => validateGenerateArgs({ outDir: "/x/output", prompt: "" }), "prompt");
    badArgs(() => validateEditArgs({ prompt: "x", in: "" }), "in");
    expect(validateEditArgs({ prompt: "x", in: "/x/a.png" }).in).toBe("/x/a.png");
    badArgs(() => validateVisionArgs({ in: "/x/a.png", check: "" }), "check");
    badArgs(() => validateVisionArgs({ in: [], check: "ok" }));
    badArgs(() => validateVisionArgs({ in: "", check: "ok" }));
    badArgs(() => validateVisionArgs({ in: ["/x/a.png", ""], check: "ok" }));
    expect(validateVisionArgs({ in: ["/x/a.png", "/x/b.png"], check: "ok" })).toBeTruthy();
    badArgs(() => validateGenerateArgs({ outDir: "/x/output", prompt: " \n\t " }), "blank");
    badArgs(() => validateEditArgs({ prompt: "\t", in: "/x/a.png" }), "blank");
    badArgs(() => validateVisionArgs({ in: "/x/a.png", check: "  " }), "blank");
  });

  it("rejects truthy strings for optional boolean controls", () => {
    badArgs(() => validateGenerateArgs({ outDir: "/x/output", prompt: "x", overwrite: "false" } as never));
    badArgs(() => validateMaskArgs({ in: "/x/a.png", dryRun: "false" } as never));
    badArgs(() => validateTrimArgs({ in: "/x/a.png", square: "false" } as never));
    badArgs(() => validateShadowArgs({ in: "/x/a.png", keepCanvas: "false" } as never));
    badArgs(() => validateIconArgs({ in: "/x/a.png", pngs: "false" } as never));
  });

  it("mask: method enum, key form, numeric bounds", () => {
    expect(validateMaskArgs({ in: "/x/a.png" })).toBeTruthy();
    expect(validateMaskArgs({ in: "/x/a.png", method: "ai" })).toBeTruthy();
    badArgs(() => validateMaskArgs({ in: "/x/a.png", method: "nope" as never }), "method must be one of");
    badArgs(() => validateMaskArgs({ in: "/x/a.png", key: "green" }), "key must be");
    expect(validateMaskArgs({ in: "/x/a.png", key: "#00ff00" })).toBeTruthy();
    expect(validateMaskArgs({ in: "/x/a.png", key: "from-sidecar" })).toBeTruthy();
    badArgs(() => validateMaskArgs({ in: "/x/a.png", saturationRatio: 5 }), "must be in (0..1]");
    badArgs(() => validateMaskArgs({ in: "/x/a.png", saturationRatio: 0 }), "must be in (0..1]");
    badArgs(() => validateMaskArgs({ in: "/x/a.png", borderSample: 0 }), "positive integer");
  });

  it("compose: required in/mask, hex removeBleed", () => {
    expect(validateComposeArgs({ in: "/x/a.png", mask: "/x/m.png" })).toBeTruthy();
    badArgs(() => validateComposeArgs({ in: "", mask: "/x/m.png" }), "in");
    badArgs(() => validateComposeArgs({ in: "/x/a.png", mask: "/x/m.png", removeBleed: "00ff00" }), "hex");
    expect(validateComposeArgs({ in: "/x/a.png", mask: "/x/m.png", removeBleed: "#00ff00" })).toBeTruthy();
  });

  it("despeckle: integer threshold/min-area, connectivity, keep enum", () => {
    expect(validateDespeckleArgs({ in: "/x/a.png" })).toBeTruthy();
    expect(
      validateDespeckleArgs({ in: "/x/a.png", threshold: 5, minArea: 100, connectivity: 8, keep: "largest" }),
    ).toBeTruthy();
    badArgs(() => validateDespeckleArgs({ in: "" }), "in");
    badArgs(() => validateDespeckleArgs({ in: "/x/a.png", threshold: 256 }), "[0..255]");
    badArgs(() => validateDespeckleArgs({ in: "/x/a.png", threshold: -1 }), "[0..255]");
    badArgs(() => validateDespeckleArgs({ in: "/x/a.png", threshold: 1.5 }), "[0..255]");
    badArgs(() => validateDespeckleArgs({ in: "/x/a.png", minArea: -1 }), "non-negative integer");
    badArgs(() => validateDespeckleArgs({ in: "/x/a.png", minArea: 2.5 }), "non-negative integer");
    badArgs(() => validateDespeckleArgs({ in: "/x/a.png", connectivity: 6 }), "must be 4 or 8");
    badArgs(() => validateDespeckleArgs({ in: "/x/a.png", keep: "biggest" as never }), "keep must be one of");
  });

  it("keycheck: required concrete key, numeric ranges, boolean heatmap", () => {
    expect(validateKeycheckArgs({ in: "/x/a.png", key: "#00ff00" })).toBeTruthy();
    expect(validateKeycheckArgs({ in: "/x/a.png", key: "from-sidecar" })).toBeTruthy();
    expect(validateKeycheckArgs({ in: "/x/a.png", key: "#ff00ff", heatmap: true })).toBeTruthy();
    badArgs(() => validateKeycheckArgs({ in: "/x/a.png" } as never), "key"); // key is required
    badArgs(() => validateKeycheckArgs({ in: "/x/a.png", key: "auto" }), "key must be"); // no "auto"
    badArgs(() => validateKeycheckArgs({ in: "/x/a.png", key: "green" }), "key must be");
    badArgs(() => validateKeycheckArgs({ in: "", key: "#00ff00" }), "in");
    badArgs(() => validateKeycheckArgs({ in: "/x/a.png", key: "#00ff00", hueTolerance: 200 }), "[0..180]");
    badArgs(() => validateKeycheckArgs({ in: "/x/a.png", key: "#00ff00", minSaturation: 2 }), "[0..1]");
    badArgs(() => validateKeycheckArgs({ in: "/x/a.png", key: "#00ff00", minValue: -0.1 }), "[0..1]");
    badArgs(() => validateKeycheckArgs({ in: "/x/a.png", key: "#00ff00", maxEdgeResidueFraction: 1.5 }), "[0..1]");
    badArgs(
      () => validateKeycheckArgs({ in: "/x/a.png", key: "#00ff00", maxInteriorResiduePixels: 1.5 }),
      "non-negative integer",
    );
  });

  it("framecheck: optional integer threshold/tolerance, axes enum", () => {
    expect(validateFramecheckArgs({ in: "/x/a.png" })).toBeTruthy();
    expect(validateFramecheckArgs({ in: "/x/a.png", threshold: 128, tolerance: 2, axes: "both" })).toBeTruthy();
    expect(validateFramecheckArgs({ in: "/x/a.png", axes: "vertical" })).toBeTruthy();
    badArgs(() => validateFramecheckArgs({ in: "" }), "in");
    badArgs(() => validateFramecheckArgs({ in: "/x/a.png", threshold: 0 }), "[1..255]"); // 0 would make solid = whole canvas
    badArgs(() => validateFramecheckArgs({ in: "/x/a.png", threshold: 256 }), "[1..255]");
    badArgs(() => validateFramecheckArgs({ in: "/x/a.png", threshold: 1.5 }), "[1..255]");
    badArgs(() => validateFramecheckArgs({ in: "/x/a.png", tolerance: -1 }), "non-negative integer");
    badArgs(() => validateFramecheckArgs({ in: "/x/a.png", tolerance: 2.5 }), "non-negative integer");
    badArgs(() => validateFramecheckArgs({ in: "/x/a.png", axes: "diagonal" as never }), "axes must be one of");
  });

  it("grid: inputs arity, numeric ranges, background form", () => {
    expect(validateGridArgs({ inputs: ["/x/a.png"] })).toBeTruthy();
    expect(validateGridArgs({ inputs: ["/x/a.png", "/x/b.png"], cols: 2, cell: 128, gap: 0 })).toBeTruthy();
    expect(validateGridArgs({ inputs: ["/x/a.png"], background: "#102030" })).toBeTruthy();
    expect(validateGridArgs({ inputs: ["/x/a.png"], background: "transparent" })).toBeTruthy();
    badArgs(() => validateGridArgs({ inputs: [] }), "at least one");
    badArgs(() => validateGridArgs({} as never), "inputs");
    badArgs(() => validateGridArgs({ inputs: ["/x/a.png", ""] }));
    badArgs(() => validateGridArgs({ inputs: ["/x/a.png"], cell: 0 }), "positive integer");
    badArgs(() => validateGridArgs({ inputs: ["/x/a.png"], gap: -1 }), "non-negative integer");
    badArgs(() => validateGridArgs({ inputs: ["/x/a.png"], gap: 1.5 }), "non-negative integer");
    badArgs(() => validateGridArgs({ inputs: ["/x/a.png"], background: "red" }), "transparent");
  });

  it("combine: op enum and op-dependent arity", () => {
    expect(validateCombineArgs({ op: "union", inputs: ["/x/a.png", "/x/b.png"] })).toBeTruthy();
    expect(validateCombineArgs({ op: "invert", inputs: ["/x/a.png"] })).toBeTruthy();
    badArgs(() => validateCombineArgs({ op: "nope" as never, inputs: ["/x/a.png"] }), "op must be one of");
    badArgs(() => validateCombineArgs({ op: "union", inputs: ["/x/a.png"] }), "expects exactly 2");
    badArgs(() => validateCombineArgs({ op: "invert", inputs: ["/x/a.png", "/x/b.png"] }), "expects exactly 1");
    badArgs(() => validateCombineArgs({ op: "feather", inputs: ["/x/a.png"], radius: -1 }), ">= 0");
    badArgs(() => validateCombineArgs({ op: "feather", inputs: ["/x/a.png"], radius: Infinity })); // non-finite rejected by z.number()
    // No upper bound: a large feather is slow and cancellable, not refused.
    expect(validateCombineArgs({ op: "feather", inputs: ["/x/a.png"], radius: 1e9 })).toBeTruthy();
  });

  it("trim / backplate: numeric ranges and enums", () => {
    expect(validateTrimArgs({ in: "/x/a.png", margin: 0.5 })).toBeTruthy();
    badArgs(() => validateTrimArgs({ in: "/x/a.png", margin: 2 }), "[0..1]");
    expect(validateBackplateArgs({ from: "#000000", to: "#ffffff", outDir: "/x/output" })).toBeTruthy();
    badArgs(() => validateBackplateArgs({ from: "nope", to: "#ffffff" }), "hex");
    badArgs(() => validateBackplateArgs({ to: "#ffffff" } as never), "from"); // from is required
    badArgs(() => validateBackplateArgs({ from: "#000000", to: "#ffffff", angle: Infinity })); // non-finite rejected by z.number()
    badArgs(() => validateBackplateArgs({ from: "#000000", to: "#ffffff", size: 0 }), "positive integer");
    badArgs(() => validateBackplateArgs({ from: "#000000", to: "#ffffff", content: 5 }), "(0..1]");
    badArgs(() => validateBackplateArgs({ from: "#000000", to: "#ffffff", radius: 0.9 }), "[0..0.5]");
    badArgs(() => validateBackplateArgs({ from: "#000000", to: "#ffffff", shape: "blob" as never }), "shape must be one of");
  });

  it("layer / shadow: enums, integer offsets, ranges", () => {
    expect(validateLayerArgs({ base: "/x/b.png", top: "/x/t.png", gravity: "north" })).toBeTruthy();
    badArgs(() => validateLayerArgs({ base: "/x/b.png", top: "/x/t.png", gravity: "middle" as never }), "gravity must be one of");
    badArgs(() => validateLayerArgs({ base: "/x/b.png", top: "/x/t.png", scale: 0 }), "positive number");
    badArgs(() => validateLayerArgs({ base: "/x/b.png", top: "/x/t.png", topOffset: { x: 1.5, y: 2 } }), "integers");
    badArgs(() => validateShadowArgs({ in: "/x/a.png", opacity: 5 }), "(0..1]");
    badArgs(() => validateShadowArgs({ in: "/x/a.png", opacity: Infinity })); // non-finite rejected by z.number()
    badArgs(() => validateShadowArgs({ in: "/x/a.png", opacity: NaN })); // NaN rejected by z.number()
    badArgs(() => validateShadowArgs({ in: "/x/a.png", spread: 1.5 }), "integer");
    badArgs(() => validateShadowArgs({ in: "/x/a.png", spread: -1 }), ">= 0");
    badArgs(() => validateShadowArgs({ in: "/x/a.png", offset: { x: 1.5, y: 0 } }), "offset must be integers");
    // No upper bounds: a canvas too large for the machine fails as memory.exhausted.
    expect(validateShadowArgs({ in: "/x/a.png", spread: 100000, offset: { x: 99999, y: -99999 } })).toBeTruthy();
    badArgs(() => validateShadowArgs({ in: "/x/a.png", blur: 0.2 }), "0 or between");
    expect(validateShadowArgs({ in: "/x/a.png", blur: 0 })).toBeTruthy();
  });

  it("upscale / resize: size ranges, kernel enum, tile minimum", () => {
    expect(validateUpscaleArgs({ in: "/x/a.png", kernel: "lanczos3" })).toBeTruthy();
    badArgs(() => validateUpscaleArgs({ in: "/x/a.png", toSize: 0 }), ">= 1");
    expect(validateUpscaleArgs({ in: "/x/a.png", toSize: 20000, tile: 4096 })).toBeTruthy();
    badArgs(() => validateUpscaleArgs({ in: "/x/a.png", kernel: "bogus" as never }), "kernel must be one of");
    badArgs(() => validateUpscaleArgs({ in: "/x/a.png", tile: 50 }), ">=");
    expect(validateResizeArgs({ in: "/x/a.png", toSize: 512 })).toBeTruthy();
    badArgs(() => validateResizeArgs({ in: "/x/a.png" } as never)); // toSize is required
    badArgs(() => validateResizeArgs({ in: "/x/a.png", toSize: 0 }), ">= 1");
    expect(validateResizeArgs({ in: "/x/a.png", toSize: 40000 })).toBeTruthy();
    badArgs(() => validateResizeArgs({ in: "/x/a.png", toSize: 99, kernel: "bogus" as never }), "kernel must be one of");
  });

  it("encode: format enum, option ranges, and options that apply to one format only", () => {
    expect(validateEncodeArgs({ in: "/x/a.png", format: "png", opaque: true })).toBeTruthy();
    expect(validateEncodeArgs({ in: "/x/a.png", format: "png", compressionLevel: 9, adaptiveFiltering: true })).toBeTruthy();
    badArgs(() => validateEncodeArgs({ in: "/x/a.png", format: "png", compressionLevel: 10 }), "[0..9]");
    badArgs(() => validateEncodeArgs({ in: "/x/a.png", format: "webp", compressionLevel: 9 }), "png only");
    badArgs(() => validateEncodeArgs({ in: "/x/a.png", format: "webp", adaptiveFiltering: true }), "png only");
    expect(validateEncodeArgs({ in: "/x/a.png", format: "webp", quality: 80 })).toBeTruthy();
    expect(validateEncodeArgs({ in: "/x/a.png", format: "webp", lossless: true })).toBeTruthy();
    badArgs(() => validateEncodeArgs({ in: "/x/a.png" } as never)); // format is required
    badArgs(() => validateEncodeArgs({ in: "/x/a.png", format: "gif" as never }), "format must be one of");
    badArgs(() => validateEncodeArgs({ in: "/x/a.png", format: "webp", quality: 0 }), "[1..100]");
    badArgs(() => validateEncodeArgs({ in: "/x/a.png", format: "webp", quality: 90.5 }), "[1..100]");
    badArgs(() => validateEncodeArgs({ in: "/x/a.png", format: "png", quality: 90 }), "webp only");
    badArgs(() => validateEncodeArgs({ in: "/x/a.png", format: "png", lossless: true }), "webp only");
    badArgs(() => validateEncodeArgs({ in: "/x/a.png", format: "webp", quality: 90, lossless: true }), "omit it with lossless");
    expect(validateEncodeArgs({ in: "/x/a.png", format: "webp", smartSubsample: true })).toBeTruthy();
    badArgs(() => validateEncodeArgs({ in: "/x/a.png", format: "png", smartSubsample: true }), "webp only");
  });

  it("every image-writing verb checks the encoder options against its format", () => {
    const verbs: Array<[string, (args: never) => unknown, object]> = [
      ["resize", validateResizeArgs as never, { in: "/x/a.png", toSize: 8 }],
      ["trim", validateTrimArgs as never, { in: "/x/a.png" }],
      ["shadow", validateShadowArgs as never, { in: "/x/a.png" }],
      ["layer", validateLayerArgs as never, { base: "/x/b.png", top: "/x/t.png" }],
      ["backplate", validateBackplateArgs as never, { from: "#000000", to: "#ffffff", outDir: "/x/output" }],
      ["grid", validateGridArgs as never, { inputs: ["/x/a.png"] }],
      ["upscale", validateUpscaleArgs as never, { in: "/x/a.png" }],
      ["despeckle", validateDespeckleArgs as never, { in: "/x/a.png" }],
      ["compose", validateComposeArgs as never, { in: "/x/a.png", mask: "/x/m.png" }],
      ["keycheck", validateKeycheckArgs as never, { in: "/x/a.png", key: "#00ff00" }],
    ];
    for (const [verb, validate, base] of verbs) {
      expect(() => validate({ ...base, format: "webp", quality: 80, smartSubsample: true, opaque: true } as never), verb).not.toThrow();
      expect(() => validate({ ...base, format: "png", compressionLevel: 9, adaptiveFiltering: true } as never), verb).not.toThrow();
      expect(() => validate({ ...base } as never), verb).not.toThrow();
      badArgs(() => validate({ ...base, format: "webp", compressionLevel: 9 } as never), "png only");
      badArgs(() => validate({ ...base, format: "webp", adaptiveFiltering: true } as never), "png only");
      badArgs(() => validate({ ...base, format: "png", quality: 80 } as never), "webp only");
      badArgs(() => validate({ ...base, quality: 80 } as never), "webp only"); // format unset is png
      badArgs(() => validate({ ...base, lossless: true } as never), "webp only");
      badArgs(() => validate({ ...base, format: "png", smartSubsample: true } as never), "webp only");
      badArgs(() => validate({ ...base, format: "webp", quality: 80, lossless: true } as never), "omit it with lossless");
      badArgs(() => validate({ ...base, format: "gif" } as never), "format must be one of");
      badArgs(() => validate({ ...base, quality: 0, format: "webp" } as never), "[1..100]");
    }
  });

  it("mask / combine / icon: only the lossless PNG options are accepted", () => {
    const verbs: Array<[string, (args: never) => unknown, object]> = [
      ["mask", validateMaskArgs as never, { in: "/x/a.png" }],
      ["combine", validateCombineArgs as never, { op: "invert", inputs: ["/x/a.png"] }],
      ["icon", validateIconArgs as never, { in: "/x/a.png" }],
    ];
    for (const [verb, validate, base] of verbs) {
      expect(() => validate({ ...base, compressionLevel: 9, adaptiveFiltering: true } as never), verb).not.toThrow();
      badArgs(() => validate({ ...base, compressionLevel: 10 } as never), "[0..9]");
      for (const refused of [{ format: "webp" }, { format: "png" }, { quality: 80 }, { lossless: true }, { smartSubsample: true }, { opaque: true }]) {
        badArgs(() => validate({ ...base, ...refused } as never), "is not accepted");
      }
    }
  });

  it("icon: name stem (no path separators)", () => {
    expect(validateIconArgs({ in: "/x/a.png", name: "app" })).toBeTruthy();
    badArgs(() => validateIconArgs({ in: "/x/a.png", name: "sub/app" }), "path separators");
    badArgs(() => validateIconArgs({ in: "/x/a.png", name: "../evil" }), "path separators");
  });

  it("model: key membership (own properties only)", () => {
    expect(() => validateModelKey("birefnet")).not.toThrow();
    badArgs(() => validateModelKey("nope"), "unknown model");
    // Inherited Object.prototype keys must be rejected, not read as an entry.
    badArgs(() => validateModelKey("toString"), "unknown model");
    badArgs(() => validateModelKey("constructor"), "unknown model");
  });

  it("the SDK enforces enums and bounds itself at runtime (§3)", async () => {
    // Calling the SDK directly (the only surface) with a bad enum or out-of-range
    // value must reject before any I/O — proving the constraint lives in the SDK's
    // own validator, not merely in a caller's type annotations.
    const tmp = await mkdtemp(path.join(tmpdir(), "gptimg-schemas-"));
    try {
      const sdk = new GptImg({ modelsDir: path.join(tmp, "models") });
      await expect(
        sdk.backplate({ from: "#000000", to: "#ffffff", shape: "blob" as never }),
      ).rejects.toMatchObject({ code: "args.invalid" });
      await expect(
        sdk.layer({ base: "/x/b.png", top: "/x/t.png", gravity: "middle" as never }),
      ).rejects.toMatchObject({ code: "args.invalid" });
      await expect(sdk.resize({ in: "/x/a.png", toSize: -1 })).rejects.toMatchObject({
        code: "args.invalid",
      });
      // encode's format-dependent options are checked through the impl too.
      await expect(sdk.encode({ in: "/x/a.png", format: "png", quality: 90 })).rejects.toMatchObject({
        code: "args.invalid",
      });
      await expect(
        sdk.despeckle({ in: "/x/a.png", connectivity: 6 }),
      ).rejects.toMatchObject({ code: "args.invalid" });
      // combine validates through the impl too (op enum + arity), not only via the
      // standalone validator.
      await expect(
        sdk.combine({ op: "nope" as never, inputs: ["/x/a.png"] }),
      ).rejects.toMatchObject({ code: "args.invalid" });
      await expect(
        sdk.combine({ op: "union", inputs: ["/x/only-one.png"] }),
      ).rejects.toMatchObject({ code: "args.invalid" });
      await expect(
        sdk.keycheck({ in: "/x/a.png", key: "green" as never }),
      ).rejects.toMatchObject({ code: "args.invalid" });
      await expect(sdk.grid({ inputs: [] })).rejects.toMatchObject({
        code: "args.invalid",
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
