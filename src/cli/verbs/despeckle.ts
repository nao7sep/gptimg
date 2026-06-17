import { Option, type Command } from "commander";
import { GptImg } from "../../gptimg.js";
import { cliCallOptions } from "../progress.js";
import { emit } from "../output.js";
import { numberArg } from "../parsers.js";
import type { DespeckleKeep } from "../../types.js";
import { DESPECKLE_KEEP } from "../../enums.js";

interface DespeckleCliOpts {
  in: string;
  threshold?: number;
  minArea?: number;
  connectivity?: number;
  keep?: DespeckleKeep;
  dryRun?: boolean;
  outDir?: string;
  outName?: string;
  log?: string;
  overwrite?: boolean;
}

export function registerDespeckle(program: Command): void {
  const cmd = program
    .command("despeckle")
    .description(
      "Denoise an RGBA cutout's alpha matte: floor faint alpha, then drop small connected components (keying speckles) while keeping all larger parts.",
    )
    .requiredOption("--in <path>", "Input RGBA image path")
    .option(
      "--threshold <n>",
      "Keep alpha >= this; zero below (the floor, and the component on-level). Default 5.",
      numberArg("--threshold"),
    )
    .option(
      "--min-area <n>",
      "Remove connected components smaller than this many pixels. 0 = remove none. Default 0.",
      numberArg("--min-area"),
    )
    .option(
      "--connectivity <n>",
      "Pixel neighbourhood for components: 4 or 8. Default 8.",
      numberArg("--connectivity"),
    )
    .addOption(
      new Option(
        "--keep <mode>",
        "Which components to keep: 'all' (those >= min-area) or 'largest'. Default all.",
      ).choices(DESPECKLE_KEEP),
    )
    .option("--dry-run", "Compute and emit stats without writing the output file")
    .option("--out-dir <dir>", "Output directory (default: same as input)")
    .option(
      "--out-name <name>",
      "Output filename stem; '.png' is appended (default: <input-stem>-despeckle)",
    )
    .option("--log <path>", "Path to log JSONL file")
    .option("--overwrite", "Overwrite an existing output file");

  cmd.action(async (opts: DespeckleCliOpts) => {
    const sdk = new GptImg();
    const result = await sdk.despeckle(
      {
        in: opts.in,
        threshold: opts.threshold,
        minArea: opts.minArea,
        connectivity: opts.connectivity,
        keep: opts.keep,
        dryRun: opts.dryRun,
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
