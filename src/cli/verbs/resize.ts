import { Option, type Command } from "commander";
import { GptImg } from "../../gptimg.js";
import type { ResampleKernel } from "../../types.js";
import { cliCallOptions } from "../progress.js";
import { emit } from "../output.js";
import { numberArg } from "../parsers.js";
import { RESAMPLE_KERNELS } from "../../enums.js";

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
      numberArg("--to-size"),
    )
    .addOption(
      new Option("--kernel <name>", "Resampling kernel. Default lanczos3.").choices(
        RESAMPLE_KERNELS,
      ),
    )
    .option("--out-dir <dir>", "Output directory (default: same as input)")
    .option("--out-name <name>", "Output filename stem; '.png' is appended (default: <input-stem>-resize)")
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
      cliCallOptions(),
    );
    emit(result);
  });
}
