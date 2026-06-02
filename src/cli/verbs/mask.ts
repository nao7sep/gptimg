import { InvalidArgumentError, Option, type Command } from "commander";
import { GptImg } from "../../gptimg.js";
import { isHexColor } from "../../color.js";
import { getAbortSignal } from "../abort.js";
import { emit } from "../output.js";
import type { MaskMethod } from "../../types.js";

function parseKeyOpt(v: string): string {
  if (v === "auto" || v === "from-sidecar") return v;
  if (isHexColor(v)) return v;
  throw new InvalidArgumentError("must be 'auto', 'from-sidecar', or '#rrggbb'");
}

function parseIntOpt(name: string) {
  return (v: string): number => {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) throw new InvalidArgumentError(`${name}: not a number`);
    return n;
  };
}

function parseSaturationRatioOpt(v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    throw new InvalidArgumentError("--saturation-ratio: expected a number in (0..1]");
  }
  return n;
}

interface MaskCliOpts {
  in: string;
  method?: MaskMethod;
  key?: string;
  preserveInterior?: boolean;
  borderSample?: number;
  saturationRatio?: number;
  dryRun?: boolean;
  outDir?: string;
  outName?: string;
  recipe?: string;
  log?: string;
  overwrite?: boolean;
}

export function registerMask(program: Command): void {
  const cmd = program
    .command("mask")
    .description("Produce a grayscale alpha mask from an image (no compositing).")
    .requiredOption("--in <path>", "Input image path")
    .addOption(
      new Option(
        "--method <name>",
        "Mask producer. 'ai' uses BiRefNet (~1-1.5GB RSS per process); run sequentially. Default chroma.",
      ).choices(["chroma", "ai"]),
    )
    .option(
      "--key <value>",
      "auto | from-sidecar | #rrggbb (chroma method only)",
      parseKeyOpt,
    )
    .option(
      "--preserve-interior",
      "Keep interior key-colored regions opaque (e.g. donut hole). Chroma method only.",
    )
    .option(
      "--border-sample <px>",
      "Border depth for --key auto",
      parseIntOpt("--border-sample"),
    )
    .option(
      "--saturation-ratio <frac>",
      "Spill ratio at which near-key pixels saturate to α=0 (0..1]. Chroma method only.",
      parseSaturationRatioOpt,
    )
    .option("--dry-run", "Compute and emit stats without writing the mask file")
    .option("--out-dir <dir>", "Output directory (default: same as input)")
    .option("--out-name <name>", "Output filename (default: <input-stem>-mask.png)")
    .option("--recipe <path>", "Path to recipe.json")
    .option("--log <path>", "Path to log JSONL file")
    .option("--overwrite", "Overwrite an existing output file");

  cmd.action(async (opts: MaskCliOpts) => {
    const sdk = new GptImg();
    const result = await sdk.mask(
      {
        in: opts.in,
        method: opts.method,
        key: opts.key,
        preserveInterior: opts.preserveInterior,
        borderSample: opts.borderSample,
        saturationRatio: opts.saturationRatio,
        dryRun: opts.dryRun,
        outDir: opts.outDir,
        outName: opts.outName,
        recipe: opts.recipe,
        log: opts.log,
        overwrite: opts.overwrite,
      },
      { signal: getAbortSignal() },
    );
    emit(result);
  });
}
