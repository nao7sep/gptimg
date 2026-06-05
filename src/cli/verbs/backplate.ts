import { Option, type Command } from "commander";
import { GptImg } from "../../gptimg.js";
import type { BackplateShape } from "../../types.js";
import { cliCallOptions } from "../progress.js";
import { emit } from "../output.js";
import { hexOption, numberArg } from "../parsers.js";

const SHAPES: BackplateShape[] = ["rect", "squircle"];

interface BackplateCliOpts {
  size?: number;
  content?: number;
  radius?: number;
  from: string;
  to: string;
  angle?: number;
  shape?: BackplateShape;
  outDir?: string;
  outName?: string;
  log?: string;
  overwrite?: boolean;
}

export function registerBackplate(program: Command): void {
  const cmd = program
    .command("backplate")
    .description(
      "Synthesize a centered rounded/squircle plate filled with a linear gradient on a transparent square canvas.",
    )
    .requiredOption("--from <#rrggbb>", "Gradient start color", hexOption("--from"))
    .requiredOption("--to <#rrggbb>", "Gradient end color", hexOption("--to"))
    .option(
      "--size <px>",
      "Output canvas side in pixels. Default 1024.",
      numberArg("--size"),
    )
    .option(
      "--content <frac>",
      "Content side as a fraction of --size (0..1]. Default 0.80.",
      numberArg("--content"),
    )
    .option(
      "--radius <frac>",
      "Corner radius as a fraction of the content side [0..0.5]. Default 0.225.",
      numberArg("--radius"),
    )
    .option(
      "--angle <deg>",
      "Gradient angle (deg, CSS convention: 0=bottom→top, 90=left→right). Default 135.",
      numberArg("--angle"),
    )
    .addOption(
      new Option("--shape <shape>", "Corner shape. Default rect.").choices(SHAPES),
    )
    .option("--out-dir <dir>", "Output directory (default: cwd)")
    .option("--out-name <name>", "Output filename (default: backplate-<size>.png)")
    .option("--log <path>", "Path to log JSONL file")
    .option("--overwrite", "Overwrite an existing output file");

  cmd.action(async (opts: BackplateCliOpts) => {
    const sdk = new GptImg();
    const result = await sdk.backplate(
      {
        size: opts.size,
        content: opts.content,
        radius: opts.radius,
        from: opts.from,
        to: opts.to,
        angle: opts.angle,
        shape: opts.shape,
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
