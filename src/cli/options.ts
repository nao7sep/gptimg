import { Command, InvalidArgumentError, Option } from "commander";

export function addAiCommonOptions(cmd: Command): Command {
  return cmd
    .option("--profile <path>", "Path to profile.json")
    .option("--recipe <path>", "Path to recipe.json")
    .option("--log <path>", "Path to log JSONL file")
    .option("--out-dir <dir>", "Output directory")
    .option("--out-name <name>", "Output stem for generated files")
    .option(
      "--set <expr...>",
      "Override recipe values: dot.path=value (repeatable; values JSON-parsed; @file form supported)",
    )
    .option("--patch <json>", "Deep-merge a JSON object into the recipe");
}

/** Adds `--overwrite` for verbs that produce image outputs (generate, edit). */
export function addOverwriteOption(cmd: Command): Command {
  return cmd.option("--overwrite", "Overwrite existing output images and sidecar");
}

export function collectMultiInput(value: string, prev: string[] = []): string[] {
  return [...prev, value];
}

export function intOption(name: string, desc: string): Option {
  return new Option(name, desc).argParser((v) => {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) throw new InvalidArgumentError("not a number");
    return n;
  });
}

export function floatOption(name: string, desc: string): Option {
  return new Option(name, desc).argParser((v) => {
    const n = parseFloat(v);
    if (Number.isNaN(n)) throw new InvalidArgumentError("not a number");
    return n;
  });
}
