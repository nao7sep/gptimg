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

function parsePositiveInt(name: string) {
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

interface ResizeCliOpts {
  in: string;
  toSize: number;
  kernel?: ResampleKernel;
  outDir?: string;
  outName?: string;
  log?: string;
  overwrite?: boolean;
}

export function registerResize(program: Command): void {
  const cmd = program
    .command("resize")
    .description(
      "Plain (model-free) resample to a target size, preserving alpha. Cheap counterpart to upscale.",
    )
    .requiredOption("--in <path>", "Input image path")
    .requiredOption(
      "--to-size <px>",
      "Output longer-side length in px (aspect preserved).",
      parsePositiveInt("--to-size"),
    )
    .option(
      "--kernel <name>",
      `Resampling kernel (${KERNELS.join(", ")}). Default lanczos3.`,
      parseKernelOpt,
    )
    .option("--out-dir <dir>", "Output directory (default: same as input)")
    .option("--out-name <name>", "Output filename (default: <input-stem>-resize.png)")
    .option("--log <path>", "Path to log JSONL file")
    .option("--overwrite", "Overwrite an existing output file");

  cmd.action(async (opts: ResizeCliOpts) => {
    const sdk = new GptImg();
    const result = await sdk.resize(
      {
        in: opts.in,
        toSize: opts.toSize,
        kernel: opts.kernel,
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
