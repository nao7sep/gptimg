import { type Command } from "commander";
import { GptImg } from "../../gptimg.js";
import { cliCallOptions } from "../progress.js";
import { emit } from "../output.js";

interface IconCliOpts {
  in: string;
  name?: string;
  pngs?: boolean;
  outDir?: string;
  log?: string;
  overwrite?: boolean;
}

export function registerIcon(program: Command): void {
  const cmd = program
    .command("icon")
    .description(
      "Pack a square master PNG (≥1024²) into icon.icns, icon.ico, and a 1024² icon.png.",
    )
    .requiredOption("--in <path>", "Square master PNG, at least 1024×1024")
    .option("--name <stem>", "Base filename for outputs (default: icon)")
    .option(
      "--pngs",
      "Also emit the loose sized-PNG set <name>-<size>.png (16…1024)",
    )
    .option("--out-dir <dir>", "Output directory (default: same as --in)")
    .option("--log <path>", "Path to log JSONL file")
    .option("--overwrite", "Overwrite existing output files");

  cmd.action(async (opts: IconCliOpts) => {
    const sdk = new GptImg();
    const result = await sdk.icon(
      {
        in: opts.in,
        name: opts.name,
        pngs: opts.pngs,
        outDir: opts.outDir,
        log: opts.log,
        overwrite: opts.overwrite,
      },
      cliCallOptions(),
    );
    emit(result);
  });
}
