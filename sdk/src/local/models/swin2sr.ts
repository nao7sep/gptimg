/**
 * Swin2SR ×4 super-resolution wrapper. The ONNX session over the installed
 * model is created by the first upscale and reused for the process lifetime.
 *
 * The model is a windowed-attention transformer with two hard constraints the
 * caller must satisfy, neither of which the exported graph handles itself:
 *
 *   1. Input H and W must be multiples of window_size (8). We reflect-pad each
 *      fed tile up to the next /8 on the right/bottom, run, then crop the 4×
 *      padding back off.
 *   2. Memory grows with the fed area: on CPU a 256² input peaks near 1.7 GB
 *      on its first pass and settles near 3 GB over repeated passes, and a
 *      512² input peaks near 6.3 GB on its first. So we tile: the image is
 *      processed in overlapping regions whose fed size is ~`tile`
 *      (constraint 1's /8 reflect-padding can push the actual model input a
 *      few px higher), and the overlap context is cropped off on merge. With
 *      a 32 px overlap, a 400² photo upscaled in nine passes differs from one
 *      pass by 0.03/255 on average and at most 14/255 at a few seam pixels,
 *      which is visually identical.
 *
 * I/O contract (transformers Swin2SRImageProcessor): input `pixel_values` is
 * NCHW RGB rescaled to [0,1] with no mean subtraction; output `reconstruction`
 * is RGB in ~[0,1] (clamp before quantizing). Confirmed empirically against the
 * pinned export.
 */

import type * as Ort from "onnxruntime-node";
import sharp from "sharp";
import { GptImgError, throwIfAborted } from "../../errors.ts";
import type { Logger } from "../../events/index.ts";
import { requireInstalledModel } from "./fetch.ts";
import type { OnnxPolicy } from "../../types.ts";
import { SWIN2SR_X4 } from "./registry.ts";
import { float32Tensor, loadSession, runSession } from "./session.ts";
import { packNchw01, unpackChwToU8 } from "./swin2sr-tensor.ts";
import {
  SWIN2SR_DEFAULT_TILE,
  SWIN2SR_MIN_TILE,
  SWIN2SR_OVERLAP as OVERLAP,
  SWIN2SR_SCALE,
  SWIN2SR_WINDOW as WINDOW,
} from "./swin2sr-constants.ts";

// Re-exported so callers that historically import these from the model module
// (e.g. the upscale verb) keep working; the definitions live, dependency-free,
// in swin2sr-constants.ts.
export { SWIN2SR_DEFAULT_TILE, SWIN2SR_MIN_TILE, SWIN2SR_SCALE };

const ceilTo = (n: number, m: number): number => Math.ceil(n / m) * m;

/** One output region plus the context-padded region actually fed to the model. */
export interface TileSpec {
  /** Output region origin + size, in source px. */
  ix: number;
  iy: number;
  tw: number;
  th: number;
  /** Fed (context-padded, clamped to image) region, in source px. */
  fx0: number;
  fy0: number;
  fw: number;
  fh: number;
  /** Context present on the top/left of the fed region (= ix-fx0, iy-fy0). */
  leftCtx: number;
  topCtx: number;
}

/**
 * Partition `width × height` into output regions of edge `tile - 2*overlap`,
 * each fed to the model with up to `overlap` px of real context on every side
 * (clamped at the image border). Pure; the inverse mapping (where each fed
 * tile's output goes) is encoded by `leftCtx`/`topCtx`. Exported for testing.
 */
export function planTiles(
  width: number,
  height: number,
  tile: number,
  overlap: number,
): TileSpec[] {
  const region = tile - 2 * overlap;
  const specs: TileSpec[] = [];
  for (let iy = 0; iy < height; iy += region) {
    const th = Math.min(region, height - iy);
    for (let ix = 0; ix < width; ix += region) {
      const tw = Math.min(region, width - ix);
      const fx0 = Math.max(0, ix - overlap);
      const fy0 = Math.max(0, iy - overlap);
      const fx1 = Math.min(width, ix + tw + overlap);
      const fy1 = Math.min(height, iy + th + overlap);
      specs.push({
        ix,
        iy,
        tw,
        th,
        fx0,
        fy0,
        fw: fx1 - fx0,
        fh: fy1 - fy0,
        leftCtx: ix - fx0,
        topCtx: iy - fy0,
      });
    }
  }
  return specs;
}

/** Extract an interleaved-RGB sub-region from a larger interleaved-RGB buffer. */
function extractRegion(
  rgb: Uint8Array,
  width: number,
  fx0: number,
  fy0: number,
  fw: number,
  fh: number,
): Uint8Array {
  const out = new Uint8Array(fw * fh * 3);
  for (let y = 0; y < fh; y++) {
    const srcStart = ((fy0 + y) * width + fx0) * 3;
    out.set(rgb.subarray(srcStart, srcStart + fw * 3), y * fw * 3);
  }
  return out;
}

/**
 * Upscale a /8-aligned interleaved-RGB buffer (pw × ph) by ×4, returning the
 * result as interleaved-RGB u8 (4·pw × 4·ph), clamped to [0,255]. This is the
 * only model-touching seam; `tileAndStitch` is injected with one of these so
 * the tiling/pad/crop/stitch geometry can be tested without loading ONNX.
 */
export type PaddedModelRun = (
  rgb: Uint8Array,
  pw: number,
  ph: number,
) => Promise<Uint8Array>;

/** Build the real ONNX-backed model runner (NCHW [0,1] in, clamped u8 ×4 out). */
function makeOnnxRun(
  session: Ort.InferenceSession,
  inputName: string,
  outputName: string,
): PaddedModelRun {
  return async (rgb, pw, ph) => {
    const outputs = await runSession(session, {
      [inputName]: await float32Tensor(packNchw01(rgb, pw, ph), [1, 3, ph, pw]),
    });
    const tensor = outputs[outputName];
    if (!tensor) {
      throw new GptImgError(
        "model.loadFailed",
        `Swin2SR session produced no output named ${outputName}.`,
      );
    }
    return unpackChwToU8(
      tensor.data as Float32Array,
      tensor.dims,
      pw * SWIN2SR_SCALE,
      ph * SWIN2SR_SCALE,
    );
  };
}

/** Reflect-pad a fed region to /8, run the model, crop back to exactly 4×(fw,fh). */
async function upscaleTile(
  runPadded: PaddedModelRun,
  rgb: Uint8Array,
  fw: number,
  fh: number,
): Promise<Uint8Array> {
  const pw = ceilTo(fw, WINDOW);
  const ph = ceilTo(fh, WINDOW);
  let fed = rgb;
  if (pw !== fw || ph !== fh) {
    fed = new Uint8Array(
      await sharp(Buffer.from(rgb), { raw: { width: fw, height: fh, channels: 3 } })
        .extend({ right: pw - fw, bottom: ph - fh, extendWith: "mirror" })
        .raw()
        .toBuffer(),
    );
  }

  const up = await runPadded(fed, pw, ph); // 4·pw × 4·ph interleaved u8
  const OW = pw * SWIN2SR_SCALE;
  const cw = fw * SWIN2SR_SCALE;
  const ch = fh * SWIN2SR_SCALE;
  const res = new Uint8Array(cw * ch * 3);
  for (let y = 0; y < ch; y++) {
    const srcStart = y * OW * 3;
    res.set(up.subarray(srcStart, srcStart + cw * 3), y * cw * 3);
  }
  return res;
}

export interface Swin2srOutput {
  rgb: Uint8Array;
  width: number;
  height: number;
  tiles: number;
}

/**
 * Tile `rgb` (width × height), upscale each region ×4 via `runPadded`, and
 * stitch the seam-cropped interiors into a single ×4 canvas. Pure given
 * `runPadded` (no model/network), so the geometry is unit-testable; the real
 * pipeline injects an ONNX-backed runner.
 */
export async function tileAndStitch(
  rgb: Uint8Array,
  width: number,
  height: number,
  tile: number,
  runPadded: PaddedModelRun,
  signal?: AbortSignal | undefined,
  logger?: Logger | undefined,
): Promise<Swin2srOutput> {
  const outW = width * SWIN2SR_SCALE;
  const outH = height * SWIN2SR_SCALE;
  const out = new Uint8Array(outW * outH * 3);
  const specs = planTiles(width, height, tile, OVERLAP);

  let done = 0;
  for (const s of specs) {
    throwIfAborted(signal);
    const fed = extractRegion(rgb, width, s.fx0, s.fy0, s.fw, s.fh);
    const up = await upscaleTile(runPadded, fed, s.fw, s.fh);
    const upW = s.fw * SWIN2SR_SCALE;
    // Copy this region's interior (skip the context margin) into the canvas.
    const rowBytes = s.tw * SWIN2SR_SCALE * 3;
    for (let y = 0; y < s.th * SWIN2SR_SCALE; y++) {
      const srcStart = ((s.topCtx * SWIN2SR_SCALE + y) * upW + s.leftCtx * SWIN2SR_SCALE) * 3;
      const dstStart = ((s.iy * SWIN2SR_SCALE + y) * outW + s.ix * SWIN2SR_SCALE) * 3;
      out.set(up.subarray(srcStart, srcStart + rowBytes), dstStart);
    }
    done++;
    logger?.progress("infer", done, specs.length, "tiles");
  }

  return { rgb: out, width: outW, height: outH, tiles: specs.length };
}

/**
 * Upscale interleaved-RGB `rgb` (width × height) by ×4, tiling as needed. The
 * model must be installed in `modelsDir`. `tile` bounds the per-pass fed
 * edge in source px (the memory knob); a fed region is reflect-padded up to the
 * model's window (8 px), so the actual model input may be slightly larger. The
 * seam-cropped overlap is fixed.
 */
export async function runSwin2srX4(
  rgb: Uint8Array,
  width: number,
  height: number,
  modelsDir: string,
  opts: {
    tile?: number;
    signal?: AbortSignal | undefined;
    onnx?: OnnxPolicy | undefined;
    logger?: Logger;
  } = {},
): Promise<Swin2srOutput> {
  const { signal } = opts;
  throwIfAborted(signal);

  // `tile` is validated at the verb boundary (>= SWIN2SR_MIN_TILE).
  const tile = opts.tile ?? SWIN2SR_DEFAULT_TILE;

  const modelPath = requireInstalledModel(SWIN2SR_X4, "swin2sr", modelsDir);
  throwIfAborted(signal);
  const session = await loadSession(modelPath, opts.onnx);
  throwIfAborted(signal);
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  if (!inputName || !outputName) {
    throw new GptImgError(
      "model.loadFailed",
      "Swin2SR ONNX session is missing an input or output. Model file may be malformed.",
    );
  }

  return tileAndStitch(
    rgb,
    width,
    height,
    tile,
    makeOnnxRun(session, inputName, outputName),
    signal,
    opts.logger,
  );
}
