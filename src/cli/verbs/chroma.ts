import type { Command } from "commander";
import { GptImg } from "../../gptimg.js";
import { getAbortSignal } from "../abort.js";
import { emit } from "../output.js";
import type { ChromaMetric, ChromaMode } from "../../types.js";

interface ChromaCliOpts {
  in: string;
  mode?: ChromaMode;
  key?: string;
  innerThreshold?: number;
  outerThreshold?: number;
  metric?: ChromaMetric;
  borderSample?: number;
  edgeBandDilate?: number;
  edgeBandErode?: number;
  despill?: boolean;
  fillHoles?: boolean;
  strictConfidence?: number;
  outDir?: string;
  outName?: string;
  maskName?: string;
  mask?: boolean;
  verify?: string;
  verifyThreshold?: number;
  log?: string;
  overwrite?: boolean;
}

function parseIntOpt(name: string) {
  return (v: string): number => {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) throw new Error(`${name}: not a number`);
    return n;
  };
}
function parseFloatOpt(name: string) {
  return (v: string): number => {
    const n = parseFloat(v);
    if (Number.isNaN(n)) throw new Error(`${name}: not a number`);
    return n;
  };
}

export function registerChroma(program: Command): void {
  const cmd = program
    .command("chroma")
    .description("Detect and remove a chroma-key background (local, no API)")
    .requiredOption("--in <path>", "Input image path")
    .option("--mode <mode>", "outer | all", "outer")
    .option("--key <value>", "auto | from-sidecar | #rrggbb", "auto")
    .option(
      "--inner-threshold <n>",
      "Distance below which pixels are background",
      parseFloatOpt("--inner-threshold"),
    )
    .option(
      "--outer-threshold <n>",
      "Distance above which pixels are subject",
      parseFloatOpt("--outer-threshold"),
    )
    .option("--metric <name>", "lab_de76 (v1 only)", "lab_de76")
    .option(
      "--border-sample <px>",
      "Border depth for auto key detection",
      parseIntOpt("--border-sample"),
    )
    .option(
      "--edge-band-dilate <px>",
      "Dilate radius for the edge band",
      parseIntOpt("--edge-band-dilate"),
    )
    .option(
      "--edge-band-erode <px>",
      "Erode radius for the edge band",
      parseIntOpt("--edge-band-erode"),
    )
    .option("--no-despill", "Disable color despill on partial-alpha pixels")
    .option("--no-fill-holes", "Disable morphological close for hole-filling")
    .option(
      "--strict-confidence <n>",
      "Higher confidence gate for region acceptance (0..1)",
      parseFloatOpt("--strict-confidence"),
    )
    .option("--out-dir <dir>", "Output directory (default: same as input)")
    .option("--out-name <name>", "Output filename")
    .option("--mask-name <name>", "Mask output filename")
    .option("--no-mask", "Do not write a mask file")
    .option("--verify <text>", "Run vision verification after chroma")
    .option(
      "--verify-threshold <n>",
      "Trigger verify when removedFraction > this (default 0)",
      parseFloatOpt("--verify-threshold"),
    )
    .option("--log <path>", "Path to log JSONL file")
    .option("--overwrite", "Overwrite existing output files");

  cmd.action(async (opts: ChromaCliOpts) => {
    const sdk = new GptImg();
    const edgeBand =
      opts.edgeBandDilate !== undefined || opts.edgeBandErode !== undefined
        ? {
            dilate: opts.edgeBandDilate ?? 2,
            erode: opts.edgeBandErode ?? 2,
          }
        : undefined;
    const result = await sdk.chroma(
      {
        in: opts.in,
        mode: opts.mode,
        key: opts.key,
        innerThreshold: opts.innerThreshold,
        outerThreshold: opts.outerThreshold,
        metric: opts.metric,
        borderSample: opts.borderSample,
        edgeBand,
        despill: opts.despill,
        fillHoles: opts.fillHoles,
        strictConfidence: opts.strictConfidence,
        outDir: opts.outDir,
        outName: opts.outName,
        maskName: opts.mask === false ? false : opts.maskName,
        verify: opts.verify,
        verifyThreshold: opts.verifyThreshold,
        log: opts.log,
        overwrite: opts.overwrite,
      },
      { signal: getAbortSignal() },
    );
    emit(result);
  });
}
