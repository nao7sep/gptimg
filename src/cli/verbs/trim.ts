import type { Command } from "commander";
import { GptImg } from "../../gptimg.js";
import { cliCallOptions } from "../progress.js";
import { emit } from "../output.js";
import { numberArg } from "../parsers.js";

interface TrimCliOpts {
  in: string;
  margin?: number;
  square?: boolean;
  outDir?: string;
  outName?: string;
  log?: string;
  overwrite?: boolean;
}

export function registerTrim(program: Command): void {
  const cmd = program
    .command("trim")
    .description(
      "Crop an RGBA image to its alpha bounding box and re-pad by a relative margin.",
    )
    .requiredOption("--in <path>", "Input RGBA image path")
    .option(
      "--margin <frac>",
      "Margin to re-pad, as fraction of the longer bbox side (0..1). Default 0.08.",
      numberArg("--margin"),
    )
    .option(
      "--square",
      "Extend the shorter axis with transparent pixels so the output is square",
    )
    .option("--out-dir <dir>", "Output directory (default: same as input)")
    .option("--out-name <name>", "Output filename stem; '.png' is appended (default: <input-stem>-trim)")
    .option("--log <path>", "Path to log JSONL file")
    .option("--overwrite", "Overwrite an existing output file");

  cmd.action(async (opts: TrimCliOpts) => {
    const sdk = new GptImg();
    const result = await sdk.trim(
      {
        in: opts.in,
        margin: opts.margin,
        square: opts.square,
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
