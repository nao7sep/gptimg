import { existsSync } from "node:fs";
import { done } from "../helpers/results.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import * as sdkEntry from "../../src/index.ts";
import { GptImg } from "../../src/index.ts";
import type {
  EncodeFormat,
  EncodingArgs,
  MaskArgs,
  ModelVerifyResult,
  PngEncodingArgs,
  RefusedResult,
  ResizeArgs,
  ResizeResult,
  VisionDetail,
  VisionPolicy,
} from "../../src/index.ts";

describe("GptImg SDK surface", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-sdk-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("exports the named types used by public signatures", () => {
    expectTypeOf<Awaited<ReturnType<GptImg["model"]["verify"]>>>().toEqualTypeOf<ModelVerifyResult>();
    expectTypeOf<Awaited<ReturnType<GptImg["resize"]>>>().toEqualTypeOf<ResizeResult | RefusedResult>();
    expectTypeOf<VisionPolicy["detail"]>().toEqualTypeOf<VisionDetail | undefined>();
    expectTypeOf<EncodingArgs["format"]>().toEqualTypeOf<EncodeFormat | undefined>();
    expectTypeOf<ResizeArgs>().toMatchTypeOf<EncodingArgs>();
    expectTypeOf<MaskArgs>().toMatchTypeOf<PngEncodingArgs>();
    expectTypeOf<MaskArgs>().not.toHaveProperty("format");
    expectTypeOf<MaskArgs>().not.toHaveProperty("dryRun");
  });

  it("exports the verbs' class, the sidecar reader, the error and code tables, and the constant lists", () => {
    expect(Object.keys(sdkEntry).sort()).toEqual([
      "BACKPLATE_SHAPES",
      "COMBINE_OPS",
      "DESPECKLE_KEEP",
      "ENCODE_FORMATS",
      "ERROR_CODES",
      "ERROR_EFFECTS",
      "ERROR_KINDS",
      "FRAMECHECK_AXES",
      "FRAMECHECK_VERDICTS",
      "GptImg",
      "GptImgError",
      "ITEM_FAILURE_CODES",
      "KEY_RESIDUE_VERDICTS",
      "LAYER_GRAVITIES",
      "MASK_METHODS",
      "MODEL_INTEGRITIES",
      "MODEL_LINEUP",
      "NETWORK_BUDGET_NAMES",
      "NETWORK_DEFAULTS",
      "REFUSAL_CODES",
      "RESAMPLE_KERNELS",
      "SUPPORTED_IMAGE_EXTENSIONS",
      "SUPPORTED_MODELS",
      "VERIFY_FINDING_CODES",
      "VERSION",
      "VISION_DETAILS",
      "completed",
      "defaultModelFor",
      "isGptImgErrorData",
      "modelsFor",
      "readSidecar",
      "validatePolicy",
    ].sort());
  });

  it("keeps no helper groups and no stored state on the instance", () => {
    const sdk = new GptImg() as unknown as Record<string, unknown>;
    for (const removed of ["profile", "recipe", "sidecar", "image", "log", "profileDir", "logDir"]) {
      expect(sdk[removed], removed).toBeUndefined();
    }
    expect(typeof sdk.model).toBe("object");
    expect(typeof sdk.verify).toBe("function");
  });

  it("refuses an option it does not take, with a hint for a retired one", () => {
    expect(() => new GptImg({ profile: {} } as never)).toThrow(
      expect.objectContaining({ code: "args.invalid", details: { field: "profile", constraint: "retired" } }),
    );
    expect(() => new GptImg({ apikey: "sk" } as never)).toThrow(
      expect.objectContaining({ code: "args.invalid", details: { field: "apikey", constraint: "known option" } }),
    );
  });

  it("touches no disk when constructed, and refuses relative locations", () => {
    new GptImg({ modelsDir: path.join(tmp, "models") });
    expect(existsSync(path.join(tmp, "models"))).toBe(false);
    expect(() => new GptImg({ modelsDir: "models" })).toThrow(expect.objectContaining({ code: "args.invalid" }));
  });

  it("keycheck resolves the key from the sidecar and measures residue end-to-end", async () => {
    const sdk = new GptImg({ modelsDir: path.join(tmp, "models") });
    // A blue island over transparent, with a generate-style sidecar recording a
    // green chroma key beside it — the from-sidecar path mask uses.
    const W = 8, H = 8;
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 2; y <= 5; y++)
      for (let x = 2; x <= 5; x++) {
        const i = (y * W + x) * 4;
        rgba[i] = 40; rgba[i + 1] = 80; rgba[i + 2] = 200; rgba[i + 3] = 255;
      }
    const imgPath = path.join(tmp, "cutout.png");
    await sharp(Buffer.from(rgba), { raw: { width: W, height: H, channels: 4 } }).png().toFile(imgPath);
    await writeFile(
      path.join(tmp, "cutout.json"),
      JSON.stringify({ formatVersion: 1, request: { chroma: { color: "#00ff00" } }, response: {}, files: [] }),
    );

    const res = done(await sdk.keycheck({ in: imgPath, key: "from-sidecar" }));
    expect(res.key).toBe("#00ff00");
    expect(res.keySource).toBe("sidecar");
    expect(res.residuePixels).toBe(0);
    expect(res.verdict).toBe("clean");
  });

  it("keycheck accepts an explicit key and writes a heatmap", async () => {
    const sdk = new GptImg({ modelsDir: path.join(tmp, "models") });
    const W = 8, H = 8;
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 2; y <= 5; y++)
      for (let x = 2; x <= 5; x++) {
        const i = (y * W + x) * 4;
        rgba[i] = 40; rgba[i + 1] = 80; rgba[i + 2] = 200; rgba[i + 3] = 255;
      }
    const imgPath = path.join(tmp, "cut.png");
    await sharp(Buffer.from(rgba), { raw: { width: W, height: H, channels: 4 } }).png().toFile(imgPath);

    const res = done(await sdk.keycheck({ in: imgPath, key: "#00ff00", heatmap: true, outName: "qa" }));
    expect(res.keySource).toBe("explicit");
    expect(res.key).toBe("#00ff00");
    expect(res.heatmapPath).toBe(path.join(tmp, "qa.png"));
    const meta = await sharp(res.heatmapPath!).metadata();
    expect(meta.width).toBe(W);
    expect(meta.height).toBe(H);
  });

  it("framecheck measures subject placement and verdicts off-centre end-to-end", async () => {
    const sdk = new GptImg({ modelsDir: path.join(tmp, "models") });
    // A 4×4 solid square pushed to the left (L=1, R=5) in a 10×10 canvas.
    const W = 10, H = 10;
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 3; y <= 6; y++)
      for (let x = 1; x <= 4; x++) {
        const i = (y * W + x) * 4;
        rgba[i] = 200; rgba[i + 1] = 50; rgba[i + 2] = 50; rgba[i + 3] = 255;
      }
    const imgPath = path.join(tmp, "subject.png");
    await sharp(Buffer.from(rgba), { raw: { width: W, height: H, channels: 4 } }).png().toFile(imgPath);

    const res = done(await sdk.framecheck({ in: imgPath }));
    expect(res.solidBBox).toEqual({ x: 1, y: 3, width: 4, height: 4 });
    expect(res.margins).toEqual({ left: 1, right: 5, top: 3, bottom: 3 });
    expect(res.deltas!.horizontal).toBe(4);
    expect(res.verdict).toBe("offset");
  });

  it("grid tiles inputs into a sheet beside the first input", async () => {
    const sdk = new GptImg({ modelsDir: path.join(tmp, "models") });
    const paths: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = path.join(tmp, `tile-${i}.png`);
      await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: i * 80, g: 0, b: 0, alpha: 1 } } })
        .png()
        .toFile(p);
      paths.push(p);
    }
    const res = done(await sdk.grid({ inputs: paths, cell: 32, gap: 4, outName: "sheet" }));
    expect(res.placed).toBe(3);
    expect(res.skipped).toEqual([]);
    expect(res.output).toBe(path.join(tmp, "sheet.png"));
  });
});
