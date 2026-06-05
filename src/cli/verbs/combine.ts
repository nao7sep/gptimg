import { Argument, type Command } from "commander";
import { GptImg } from "../../gptimg.js";
import { getAbortSignal } from "../abort.js";
import { emit } from "../output.js";
import { numberArg } from "../parsers.js";
import type { CombineOp } from "../../types.js";

const VALID_OPS: readonly CombineOp[] = [
  "union",
  "intersect",
  "subtract",
  "invert",
  "feather",
];

interface CombineCliOpts {
  in?: string[];
  radius?: number;
  outDir?: string;
  outName?: string;
  log?: string;
  overwrite?: boolean;
}

function collectInputs(value: string, prev: string[] = []): string[] {
  return [...prev, value];
}

export function registerCombine(program: Command): void {
  const cmd = program
    .command("combine")
    .description(
      "Combine masks via set operations. " +
        `<op> is one of: ${VALID_OPS.join(", ")}.`,
    )
    .addArgument(
      new Argument("<op>", `One of: ${VALID_OPS.join(", ")}`).choices(VALID_OPS),
    )
    .requiredOption(
      "--in <path>",
      "Input mask path (repeat for binary ops; 1 input for invert/feather)",
      collectInputs,
    )
    .option(
      "--radius <n>",
      "Feather radius (number of 3×3 box-blur passes). Required for feather.",
      numberArg("--radius"),
    )
    .option("--out-dir <dir>", "Output directory (default: same as first input)")
    .option("--out-name <name>", "Output filename (default: <first-stem>-<op>.png)")
    .option("--log <path>", "Path to log JSONL file")
    .option("--overwrite", "Overwrite an existing output file");

  cmd.action(async (op: CombineOp, opts: CombineCliOpts) => {
    const sdk = new GptImg();
    const result = await sdk.combine(
      {
        op,
        inputs: opts.in ?? [],
        radius: opts.radius,
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
