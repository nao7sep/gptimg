import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { LocalOpError } from "../../errors.js";
import { writeMaskPNG, writeRGBA } from "../../image/bridge.js";
import type {
  ChromaArgs,
  ChromaStats,
} from "../../types.js";
import { despill as applyDespill } from "./despill.js";
import { CHROMA_DEFAULTS, detect } from "./detect.js";

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

export async function runChroma(args: ChromaArgs): Promise<ChromaPipelineOutput> {
  const result = await detect(args);
  const { width, height, rgba, alpha, keyResolution, stats } = result;
  const totalPixels = width * height;

  const doDespill = args.despill ?? CHROMA_DEFAULTS.despill;
  if (doDespill) {
    applyDespill(rgba, width, height, alpha, keyResolution.hex);
  }

  for (let p = 0, i = 0; p < totalPixels; p++, i += 4) {
    rgba[i + 3] = alpha[p]!;
  }

  const inDir = path.dirname(args.in);
  const outDir = args.outDir ? args.outDir : inDir;
  await mkdir(outDir, { recursive: true });

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
