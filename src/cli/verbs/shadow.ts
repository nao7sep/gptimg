import type { Command } from "commander";
import { GptImg } from "../../gptimg.js";
import type { ShadowOffset } from "../../types.js";
import { cliCallOptions } from "../progress.js";
import { emit } from "../output.js";
import { hexOption, numberArg, pointArg } from "../parsers.js";

interface ShadowCliOpts {
  in: string;
  blur?: number;
  offset?: ShadowOffset;
  color?: string;
  opacity?: number;
  spread?: number;
  keepCanvas?: boolean;
  outDir?: string;
  outName?: string;
  log?: string;
  overwrite?: boolean;
}

export function registerShadow(program: Command): void {
  const cmd = program
    .command("shadow")
    .description(
      "Cast a soft drop shadow from an RGBA image's alpha shape and composite the subject on top.",
    )
    .requiredOption("--in <path>", "Input RGBA image path")
    .option(
      "--blur <px>",
      "Gaussian blur sigma for the shadow edge. Default 12.",
      numberArg("--blur"),
    )
    .option(
      "--offset <x,y>",
      'Shadow displacement, integers (may be negative). Default "0,8".',
      pointArg("--offset"),
    )
    .option("--color <#rrggbb>", "Shadow color. Default #000000.", hexOption("--color"))
    .option(
      "--opacity <frac>",
      "Peak shadow opacity (0..1]. Default 0.35.",
      numberArg("--opacity"),
    )
    .option(
      "--spread <px>",
      "Grow the shadow shape outward before blurring. Default 0.",
      numberArg("--spread"),
    )
    .option(
      "--keep-canvas",
      "Keep the input dimensions, clipping any shadow outside (default: grow to fit).",
    )
    .option("--out-dir <dir>", "Output directory (default: same as --in)")
    .option(
      "--out-name <name>",
      "Output filename stem; '.png' is appended (default: <in-stem>-shadow)",
    )
    .option("--log <path>", "Path to log JSONL file")
    .option("--overwrite", "Overwrite an existing output file");

  cmd.action(async (opts: ShadowCliOpts) => {
    const sdk = new GptImg();
    const result = await sdk.shadow(
      {
        in: opts.in,
        blur: opts.blur,
        offset: opts.offset,
        color: opts.color,
        opacity: opts.opacity,
        spread: opts.spread,
        keepCanvas: opts.keepCanvas,
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
