import { Option, type Command } from "commander";
import { GptImg } from "../../gptimg.js";
import type { ResampleKernel } from "../../types.js";
import { cliCallOptions } from "../progress.js";
import { emit } from "../output.js";
import { numberArg } from "../parsers.js";
import { RESAMPLE_KERNELS } from "../../enums.js";

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
      numberArg("--to-size"),
    )
    .addOption(
      new Option(
        "--kernel <name>",
        "Resampling kernel for the resize after ×4. Default lanczos3.",
      ).choices(RESAMPLE_KERNELS),
    )
    .option(
      "--tile <px>",
      "Approx. model-input edge per pass — the memory knob (larger = fewer passes, more RAM). Default 256.",
      numberArg("--tile"),
    )
    .option("--recipe <path>", "Path to recipe.json (for network.modelDownload)")
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
      cliCallOptions(),
    );
    emit(result);
  });
}
