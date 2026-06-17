import { type Command } from "commander";
import { GptImg } from "../../gptimg.js";
import { cliCallOptions } from "../progress.js";
import { emit } from "../output.js";
import { hexOption } from "../parsers.js";

interface ComposeCliOpts {
  in: string;
  mask: string;
  over?: string;
  removeBleed?: string;
  outDir?: string;
  outName?: string;
  log?: string;
  overwrite?: boolean;
}

export function registerCompose(program: Command): void {
  const cmd = program
    .command("compose")
    .description("Apply a mask to an image. Optionally flatten over a color or background image.")
    .requiredOption("--in <path>", "Input image path")
    .requiredOption("--mask <path>", "Mask PNG (grayscale, same size as --in)")
    .option(
      "--over <value>",
      "Flatten target: '#rrggbb' for solid color, or a path to another image. Omit for transparent output.",
    )
    .option(
      "--remove-bleed <#rrggbb>",
      "Remove this bg color from kept subject pixels. Dispatches on the key's chromaticity: a chromatic key (R/G/B/C/M/Y) gets spill suppression (no edge recovery); a gray key gets alpha-aware edge recovery at partial-α pixels.",
      hexOption("--remove-bleed"),
    )
    .option("--out-dir <dir>", "Output directory (default: same as input)")
    .option("--out-name <name>", "Output filename stem; '.png' is appended (default: <input-stem>-composed)")
    .option("--log <path>", "Path to log JSONL file")
    .option("--overwrite", "Overwrite an existing output file");

  cmd.action(async (opts: ComposeCliOpts) => {
    const sdk = new GptImg();
    const result = await sdk.compose(
      {
        in: opts.in,
        mask: opts.mask,
        over: opts.over,
        removeBleed: opts.removeBleed,
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
