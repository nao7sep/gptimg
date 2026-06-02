import { Command } from "commander";

export function addAiCommonOptions(cmd: Command): Command {
  return cmd
    .option("--profile <path>", "Path to profile.json")
    .option("--recipe <path>", "Path to recipe.json")
    .option("--log <path>", "Path to log JSONL file")
    .option("--out-dir <dir>", "Output directory (default: ~/.gptimg/output)")
    .option("--out-name <name>", "Output filename stem (default: a UTC timestamp)")
    .option(
      "--set <expr...>",
      "Override recipe values: dot.path=value (repeatable; values JSON-parsed; @file form supported)",
    );
}

/** Adds `--overwrite` for verbs that produce image outputs (generate, edit). */
export function addOverwriteOption(cmd: Command): Command {
  return cmd.option(
    "--overwrite",
    "Replace the artifact group for <out-name> in <out-dir>. Refuses when prior-run siblings exist that this run will not overwrite (output.staleSiblings); delete them or pick a fresh --out-name.",
  );
}

export function collectMultiInput(value: string, prev: string[] = []): string[] {
  return [...prev, value];
}
