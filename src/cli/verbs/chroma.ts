import { InvalidArgumentError, Option, type Command } from "commander";
import { GptImg } from "../../gptimg.js";
import { getAbortSignal } from "../abort.js";
import { emit } from "../output.js";
import type { ChromaMetric } from "../../types.js";

function parseKeyOpt(v: string): string {
  if (v === "auto" || v === "from-sidecar") return v;
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
  throw new InvalidArgumentError("must be 'auto', 'from-sidecar', or '#rrggbb'");
}

interface ChromaCliOpts {
  in: string;
  preserveInterior?: boolean;
  key?: string;
  innerThreshold?: number;
  metric?: ChromaMetric;
  borderSample?: number;
  fillHoles?: boolean;
  strictConfidence?: number;
  outDir?: string;
  outName?: string;
  maskName?: string;
  mask?: boolean;
  recipe?: string;
  log?: string;
  overwrite?: boolean;
}

function parseIntOpt(name: string) {
  return (v: string): number => {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) throw new InvalidArgumentError(`${name}: not a number`);
    return n;
  };
}
function parseFloatOpt(name: string) {
  return (v: string): number => {
    const n = parseFloat(v);
    if (Number.isNaN(n)) throw new InvalidArgumentError(`${name}: not a number`);
    return n;
  };
}

export function registerChroma(program: Command): void {
  const cmd = program
    .command("chroma")
    .description("Detect and remove a chroma-key background (local, no API)")
    .requiredOption("--in <path>", "Input image path")
    .option(
      "--preserve-interior",
      "Keep interior key-colored regions opaque (e.g. donut holes, intentional green subject content). Default removes them.",
    )
    .option(
      "--key <value>",
      "auto | from-sidecar | #rrggbb (default: auto, unless recipe.chroma.color is set)",
      parseKeyOpt,
    )
    .option(
      "--inner-threshold <n>",
      "Distance below which pixels are background",
      parseFloatOpt("--inner-threshold"),
    )
    .addOption(
      new Option("--metric <name>", "Distance metric").choices(["lab_de76"]),
    )
    .option(
      "--border-sample <px>",
      "Border depth for auto key detection",
      parseIntOpt("--border-sample"),
    )
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
    .option("--recipe <path>", "Path to recipe JSON file")
    .option("--log <path>", "Path to log JSONL file")
    .option("--overwrite", "Overwrite existing output files");

  cmd.action(async (opts: ChromaCliOpts) => {
    const sdk = new GptImg();
    const result = await sdk.chroma(
      {
        in: opts.in,
        preserveInterior: opts.preserveInterior,
        key: opts.key,
        innerThreshold: opts.innerThreshold,
        metric: opts.metric,
        borderSample: opts.borderSample,
        fillHoles: opts.fillHoles,
        strictConfidence: opts.strictConfidence,
        outDir: opts.outDir,
        outName: opts.outName,
        maskName: opts.mask === false ? false : opts.maskName,
        recipe: opts.recipe,
        log: opts.log,
        overwrite: opts.overwrite,
      },
      { signal: getAbortSignal() },
    );
    emit(result);
  });
}
