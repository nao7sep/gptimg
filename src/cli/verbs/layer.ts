import { Option, type Command } from "commander";
import { GptImg } from "../../gptimg.js";
import type { LayerGravity, LayerOffset } from "../../types.js";
import { cliCallOptions } from "../progress.js";
import { emit } from "../output.js";
import { numberArg, pointArg } from "../parsers.js";
import { LAYER_GRAVITIES } from "../../enums.js";

interface LayerCliOpts {
  base: string;
  top: string;
  scale?: number;
  gravity?: LayerGravity;
  topOffset?: LayerOffset;
  outDir?: string;
  outName?: string;
  log?: string;
  overwrite?: boolean;
}

export function registerLayer(program: Command): void {
  const cmd = program
    .command("layer")
    .description(
      "Alpha-composite a top RGBA image onto a base RGBA image (sharp source-over).",
    )
    .requiredOption("--base <path>", "Base RGBA image path")
    .requiredOption("--top <path>", "Top RGBA image path")
    .option(
      "--scale <n>",
      "Resize top so its longer side = scale * min(baseW, baseH). Preserves aspect.",
      numberArg("--scale"),
    )
    .addOption(
      new Option(
        "--gravity <pos>",
        "Placement anchor. Default center. Ignored if --top-offset is given.",
      ).choices(LAYER_GRAVITIES),
    )
    .option(
      "--top-offset <x,y>",
      "Explicit pixel offset of top's top-left corner from base's top-left (overrides --gravity).",
      pointArg("--top-offset"),
    )
    .option("--out-dir <dir>", "Output directory (default: same as --base)")
    .option(
      "--out-name <name>",
      "Output filename (default: <base-stem>-layered.png)",
    )
    .option("--log <path>", "Path to log JSONL file")
    .option("--overwrite", "Overwrite an existing output file");

  cmd.action(async (opts: LayerCliOpts) => {
    const sdk = new GptImg();
    const result = await sdk.layer(
      {
        base: opts.base,
        top: opts.top,
        scale: opts.scale,
        gravity: opts.gravity,
        topOffset: opts.topOffset,
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
