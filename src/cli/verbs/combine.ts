import { InvalidArgumentError, type Command } from "commander";
import { GptImg } from "../../gptimg.js";
import { getAbortSignal } from "../abort.js";
import { emit } from "../output.js";
import type { CombineOp } from "../../types.js";

const VALID_OPS: readonly CombineOp[] = [
  "union",
  "intersect",
  "subtract",
  "invert",
  "feather",
];

function parseIntOpt(name: string) {
  return (v: string): number => {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) throw new InvalidArgumentError(`${name}: not a number`);
    return n;
  };
}

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
    .argument("<op>", `One of: ${VALID_OPS.join(", ")}`)
    .requiredOption(
      "--in <path>",
      "Input mask path (repeat for binary ops; 1 input for invert/feather)",
      collectInputs,
    )
    .option(
      "--radius <n>",
      "Feather radius (number of 3×3 box-blur passes). Required for feather.",
      parseIntOpt("--radius"),
    )
    .option("--out-dir <dir>", "Output directory (default: same as first input)")
    .option("--out-name <name>", "Output filename (default: <first-stem>-<op>.png)")
    .option("--log <path>", "Path to log JSONL file")
    .option("--overwrite", "Overwrite an existing output file");

  cmd.action(async (op: string, opts: CombineCliOpts) => {
    if (!VALID_OPS.includes(op as CombineOp)) {
      cmd.error(
        `invalid op '${op}'; must be one of ${VALID_OPS.join(", ")}`,
        { code: "commander.invalidArgument" },
      );
    }
    const sdk = new GptImg();
    const result = await sdk.combine(
      {
        op: op as CombineOp,
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
