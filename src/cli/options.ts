import { Command, Option } from "commander";

export function addAiCommonOptions(cmd: Command): Command {
  return cmd
    .option("--profile <path>", "Path to profile.json")
    .option("--recipe <path>", "Path to recipe.json")
    .option("--log <path>", "Path to log JSONL file")
    .option("--out-dir <dir>", "Output directory")
    .option("--out-name <name>", "Output filename stem (extension auto-detected)")
    .option(
      "--set <expr...>",
      "Override a recipe field: dot.path=value (repeatable; values JSON-parsed; @file form supported)",
    )
    .option("--patch <json>", "Deep-merge JSON object into the recipe section")
    .option("--overwrite", "Overwrite existing output files");
}

export function collectMultiInput(value: string, prev: string[] = []): string[] {
  return [...prev, value];
}

export function intOption(name: string, desc: string): Option {
  return new Option(name, desc).argParser((v) => {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) throw new Error(`${name}: not a number`);
    return n;
  });
}

export function floatOption(name: string, desc: string): Option {
  return new Option(name, desc).argParser((v) => {
    const n = parseFloat(v);
    if (Number.isNaN(n)) throw new Error(`${name}: not a number`);
    return n;
  });
}
