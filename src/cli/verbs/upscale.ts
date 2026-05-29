import { InvalidArgumentError, type Command } from "commander";
import { GptImg } from "../../gptimg.js";
import type { ResampleKernel } from "../../types.js";
import { getAbortSignal } from "../abort.js";
import { emit } from "../output.js";

const KERNELS: readonly ResampleKernel[] = [
  "nearest",
  "cubic",
  "mitchell",
  "lanczos2",
  "lanczos3",
];

function parsePositiveIntOpt(name: string) {
  return (v: string): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) {
      throw new InvalidArgumentError(`${name}: must be a positive integer`);
    }
    return n;
  };
}

function parseKernelOpt(v: string): ResampleKernel {
  if (!KERNELS.includes(v as ResampleKernel)) {
    throw new InvalidArgumentError(`must be one of ${KERNELS.join(", ")}`);
  }
  return v as ResampleKernel;
}

interface UpscaleCliOpts {
  in: string;
  toSize?: number;
  kernel?: ResampleKernel;
  tile?: number;
  recipe?: string;
  outDir?: string;
  outName?: string;
  log?: string;
  overwrite?: boolean;
}

export function registerUpscale(program: Command): void {
  const cmd = program
    .command("upscale")
    .description(
      "Learned ×4 super-resolution (Swin2SR), then resample to a target size. Preserves alpha.",
    )
    .requiredOption("--in <path>", "Input RGBA image path")
    .option(
      "--to-size <px>",
      "Final output longer-side length in px (aspect preserved). Default 1024.",
      parsePositiveIntOpt("--to-size"),
    )
    .option(
      "--kernel <name>",
      `Resampling kernel for the resize after ×4 (${KERNELS.join(", ")}). Default lanczos3.`,
      parseKernelOpt,
    )
    .option(
      "--tile <px>",
      "Approx. model-input edge per pass — the memory knob (larger = fewer passes, more RAM). Default 256.",
      parsePositiveIntOpt("--tile"),
    )
    .option("--recipe <path>", "Path to recipe JSON file (for network.modelDownload)")
    .option("--out-dir <dir>", "Output directory (default: same as input)")
    .option("--out-name <name>", "Output filename (default: <input-stem>-upscale.png)")
    .option("--log <path>", "Path to log JSONL file")
    .option("--overwrite", "Overwrite an existing output file");

  cmd.action(async (opts: UpscaleCliOpts) => {
    const sdk = new GptImg();
    const result = await sdk.upscale(
      {
        in: opts.in,
        toSize: opts.toSize,
        kernel: opts.kernel,
        tile: opts.tile,
        recipe: opts.recipe,
        outDir: opts.outDir,
        outName: opts.outName,
        log: opts.log,
        overwrite: opts.overwrite,
      },
      { signal: getAbortSignal() },
    );
    emit(result);
  });
}
