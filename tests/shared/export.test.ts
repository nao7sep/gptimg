import { describe, expect, it } from "vitest";
import { defaultExportPrefs, exportCall, exportName, fillFor, outputSize, parseExportPrefs, type ExportPrefs, type ImageInfo } from "../../src/shared/export.ts";

const info: ImageInfo = { width: 1024, height: 1536, format: "png", fileBytes: 2_000_000, transparent: true };
const prefs = (over: Partial<ExportPrefs>): ExportPrefs => ({ ...defaultExportPrefs(), ...over });

describe("export rules", () => {
  it("sizes the output by its longest side, aspect kept", () => {
    expect(outputSize(1024, 1536, { kind: "original" })).toEqual({ width: 1024, height: 1536 });
    expect(outputSize(1024, 1536, { kind: "longSide", px: 768 })).toEqual({ width: 512, height: 768 });
    expect(outputSize(1024, 1536, { kind: "upscale", factor: 4 })).toEqual({ width: 4096, height: 6144 });
  });

  it("fills transparency only when the image has it, always for JPEG", () => {
    expect(fillFor(prefs({ format: "png", fill: null }), true)).toBeNull();
    expect(fillFor(prefs({ format: "jpeg", fill: null }), true)).toBe("#ffffff");
    expect(fillFor(prefs({ format: "webp", fill: "#123456" }), true)).toBe("#123456");
    expect(fillFor(prefs({ format: "jpeg", fill: "#123456" }), false)).toBeNull();
  });

  it("picks the SDK verb and its encoder options", () => {
    const request = { ...prefs({ format: "jpeg", quality: 80 }), path: "/s/a.png" };
    expect(exportCall(request, info, "/tmp/x", "export")).toEqual({
      op: "encode",
      args: { in: "/s/a.png", outDir: "/tmp/x", outName: "export", format: "jpeg", quality: 80, background: "#ffffff" },
    });
    const up = exportCall({ ...prefs({ format: "png", size: { kind: "upscale", factor: 2 } }), path: "/s/a.png" }, info, "/tmp/x", "export");
    expect(up).toEqual({ op: "upscale", args: { in: "/s/a.png", outDir: "/tmp/x", outName: "export", format: "png", toSize: 3072 } });
    const lossless = exportCall({ ...prefs({ format: "webp", lossless: true, size: { kind: "longSide", px: 512 } }), path: "/s/a.png" }, { ...info, transparent: false }, "/t", "e");
    expect(lossless).toEqual({ op: "resize", args: { in: "/s/a.png", outDir: "/t", outName: "e", format: "webp", lossless: true, toSize: 512 } });
  });

  it("suggests a name from the image's stem, its new size and the format", () => {
    expect(exportName("/s/20261019-024905-utc.png", prefs({ format: "jpeg" }), { width: 1024, height: 1536 }, info)).toBe("20261019-024905-utc.jpg");
    expect(exportName("C:\\s\\fox.png", prefs({ format: "webp" }), { width: 2048, height: 3072 }, info)).toBe("fox-2048x3072.webp");
  });

  it("reads remembered choices, dropping what it cannot use", () => {
    expect(parseExportPrefs({ format: "gif", quality: 500, size: { kind: "upscale", factor: 3 }, fill: "red" })).toEqual(defaultExportPrefs());
    expect(parseExportPrefs({ format: "webp", quality: 75, lossless: true, size: { kind: "longSide", px: 800 }, fill: "#000000" })).toEqual({
      format: "webp",
      quality: 75,
      lossless: true,
      size: { kind: "longSide", px: 800 },
      fill: "#000000",
    });
  });
});
