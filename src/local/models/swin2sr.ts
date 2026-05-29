/**
 * Swin2SR ×4 super-resolution wrapper. Lazy: the ONNX session is created on
 * first use and reused for the process lifetime.
 *
 * The model is a windowed-attention transformer with two hard constraints the
 * caller must satisfy, neither of which the exported graph handles itself:
 *
 *   1. Input H and W must be multiples of window_size (8). We reflect-pad each
 *      fed tile up to the next /8 on the right/bottom, run, then crop the 4×
 *      padding back off.
 *   2. Memory grows ~quadratically with input area (a 256² input peaks ~4.4 GB
 *      on CPU). So we tile: the image is processed in overlapping regions whose
 *      fed size is bounded by `tile`, and the overlap context is cropped off on
 *      merge so the result is seam-free. An overlap of 32 px keeps the worst-
 *      case (hard high-frequency edges) within ~6/255 of a single-pass result
 *      and is visually identical on real content.
 *
 * I/O contract (transformers Swin2SRImageProcessor): input `pixel_values` is
 * NCHW RGB rescaled to [0,1] with no mean subtraction; output `reconstruction`
 * is RGB in ~[0,1] (clamp before quantizing). Confirmed empirically against the
 * pinned export.
 */

import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { LocalOpError, toAbortError } from "../../errors.js";
import type { Logger } from "../../log/index.js";
import type { NetworkBudget } from "../../network/defaults.js";
import { ensureModel } from "./fetch.js";
import { SWIN2SR_X4 } from "./registry.js";
import { loadSession } from "./session.js";

export const SWIN2SR_SCALE = 4;
const WINDOW = 8;
/** Context overlap (source px) kept around each tile and cropped off on merge. */
const OVERLAP = 32;
/** Default max fed model-input edge per pass — the memory knob (~4.4 GB at 256). */
export const SWIN2SR_DEFAULT_TILE = 256;
/** Smallest usable tile: must leave an interior region of at least one window. */
export const SWIN2SR_MIN_TILE = 2 * OVERLAP + WINDOW;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw toAbortError(signal.reason);
}

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

/** Run one tile: reflect-pad to /8, infer, return the 4× result cropped to 4×(fw,fh). */
async function upscaleTile(
  session: ort.InferenceSession,
  inputName: string,
  outputName: string,
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

  const n = pw * ph;
  const input = new Float32Array(3 * n);
  for (let p = 0, i = 0; p < n; p++, i += 3) {
    input[p] = fed[i]! / 255;
    input[n + p] = fed[i + 1]! / 255;
    input[2 * n + p] = fed[i + 2]! / 255;
  }

  const outputs = await session.run({
    [inputName]: new ort.Tensor("float32", input, [1, 3, ph, pw]),
  });
  const tensor = outputs[outputName];
  if (!tensor) {
    throw new LocalOpError(
      "model.loadFailed",
      `Swin2SR session produced no output named ${outputName}.`,
    );
  }
  const dims = tensor.dims;
  if (
    dims.length !== 4 ||
    dims[0] !== 1 ||
    dims[1] !== 3 ||
    Number(dims[2]) !== ph * SWIN2SR_SCALE ||
    Number(dims[3]) !== pw * SWIN2SR_SCALE
  ) {
    throw new LocalOpError(
      "model.outputShape",
      `Swin2SR output shape unexpected: got [${dims.join(",")}], expected [1,3,${ph * SWIN2SR_SCALE},${pw * SWIN2SR_SCALE}].`,
    );
  }

  const data = tensor.data as Float32Array;
  const OW = Number(dims[3]);
  const ON = OW * Number(dims[2]);
  // Crop off the reflect-padding: keep only 4×(fw, fh).
  const cw = fw * SWIN2SR_SCALE;
  const ch = fh * SWIN2SR_SCALE;
  const res = new Uint8Array(cw * ch * 3);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const src = y * OW + x;
      const dst = (y * cw + x) * 3;
      for (let c = 0; c < 3; c++) {
        const v = data[c * ON + src]!;
        res[dst + c] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
      }
    }
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
 * Upscale interleaved-RGB `rgb` (width × height) by ×4, tiling as needed. The
 * model is downloaded + cached on first use. `tile` bounds the per-pass fed
 * edge (memory); the seamless overlap is fixed.
 */
export async function runSwin2srX4(
  rgb: Uint8Array,
  width: number,
  height: number,
  cacheDir: string,
  opts: {
    tile?: number;
    signal?: AbortSignal | undefined;
    budget?: NetworkBudget;
    logger?: Logger;
  } = {},
): Promise<Swin2srOutput> {
  const { signal } = opts;
  throwIfAborted(signal);

  // `tile` is validated at the verb boundary (>= SWIN2SR_MIN_TILE).
  const tile = opts.tile ?? SWIN2SR_DEFAULT_TILE;

  const modelPath = await ensureModel(SWIN2SR_X4, cacheDir, opts);
  const session = await loadSession(modelPath);
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  if (!inputName || !outputName) {
    throw new LocalOpError(
      "model.loadFailed",
      "Swin2SR ONNX session is missing an input or output. Model file may be malformed.",
    );
  }

  const outW = width * SWIN2SR_SCALE;
  const outH = height * SWIN2SR_SCALE;
  const out = new Uint8Array(outW * outH * 3);
  const specs = planTiles(width, height, tile, OVERLAP);

  for (const s of specs) {
    throwIfAborted(signal);
    const fed = extractRegion(rgb, width, s.fx0, s.fy0, s.fw, s.fh);
    const up = await upscaleTile(session, inputName, outputName, fed, s.fw, s.fh);
    const upW = s.fw * SWIN2SR_SCALE;
    // Copy this region's interior (skip the context margin) into the canvas.
    const rowBytes = s.tw * SWIN2SR_SCALE * 3;
    for (let y = 0; y < s.th * SWIN2SR_SCALE; y++) {
      const srcStart = ((s.topCtx * SWIN2SR_SCALE + y) * upW + s.leftCtx * SWIN2SR_SCALE) * 3;
      const dstStart = ((s.iy * SWIN2SR_SCALE + y) * outW + s.ix * SWIN2SR_SCALE) * 3;
      out.set(up.subarray(srcStart, srcStart + rowBytes), dstStart);
    }
  }

  return { rgb: out, width: outW, height: outH, tiles: specs.length };
}
