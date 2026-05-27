import path from "node:path";
import { existsSync } from "node:fs";
import { LocalOpError } from "../../errors.js";
import { writeMaskPNG, writeRGBA } from "../../image/bridge.js";
import { ensureOutputDir } from "../../internal/output-files.js";
import type {
  ChromaArgs,
  ChromaStats,
} from "../../types.js";
import { despill as applyDespill } from "./despill.js";
import { CHROMA_DEFAULTS, detect, throwIfAborted } from "./detect.js";

export { CHROMA_DEFAULTS } from "./detect.js";

export interface ChromaPipelineOutput {
  imagePath: string;
  maskPath: string | null;
  stats: ChromaStats;
}

function inferStem(filePath: string): string {
  const base = path.basename(filePath);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function defaultOutputName(input: string): string {
  return `${inferStem(input)}-chroma.png`;
}

function defaultMaskName(input: string): string {
  return `${inferStem(input)}-mask.png`;
}

function checkOverwrite(filePath: string, allowOverwrite: boolean): void {
  if (!allowOverwrite && existsSync(filePath)) {
    throw new LocalOpError(
      "output.exists",
      `Output exists: ${filePath}. Use --overwrite to allow.`,
    );
  }
}

function computeDespillBand(
  detectorBand: Uint8Array,
  alpha: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(detectorBand);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (alpha[idx]! <= 5) continue;
      let nearTransparent = false;
      for (let dy = -2; dy <= 2 && !nearTransparent; dy++) {
        for (let dx = -2; dx <= 2 && !nearTransparent; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (alpha[ny * width + nx]! <= 5) nearTransparent = true;
        }
      }
      if (nearTransparent) out[idx] = 255;
    }
  }
  return out;
}

export async function runChroma(
  args: ChromaArgs,
  opts: { signal?: AbortSignal | undefined } = {},
): Promise<ChromaPipelineOutput> {
  const { signal } = opts;
  const result = await detect(args, { signal });
  const { width, height, rgba, alpha, keyResolution, stats } = result;
  const totalPixels = width * height;

  throwIfAborted(signal);
  const doDespill = args.despill ?? CHROMA_DEFAULTS.despill;
  if (doDespill) {
    applyDespill(
      rgba,
      width,
      height,
      alpha,
      keyResolution.hex,
      computeDespillBand(result.band, alpha, width, height),
    );
  }

  for (let p = 0, i = 0; p < totalPixels; p++, i += 4) {
    rgba[i + 3] = alpha[p]!;
  }

  const inDir = path.dirname(args.in);
  const outDir = args.outDir ? args.outDir : inDir;
  await ensureOutputDir(outDir);

  const outName = args.outName ?? defaultOutputName(args.in);
  const outPath = path.isAbsolute(outName) ? outName : path.join(outDir, outName);
  const overwrite = args.overwrite ?? false;
  checkOverwrite(outPath, overwrite);

  let maskPath: string | null = null;
  if (args.maskName !== false) {
    const maskName =
      typeof args.maskName === "string" ? args.maskName : defaultMaskName(args.in);
    maskPath = path.isAbsolute(maskName) ? maskName : path.join(outDir, maskName);
    checkOverwrite(maskPath, overwrite);
  }

  throwIfAborted(signal);
  await writeRGBA(rgba, width, height, outPath);
  if (maskPath) {
    const removalMask = new Uint8Array(totalPixels);
    for (let p = 0; p < totalPixels; p++) {
      removalMask[p] = 255 - alpha[p]!;
    }
    await writeMaskPNG(removalMask, width, height, maskPath);
  }

  return { imagePath: outPath, maskPath, stats };
}
