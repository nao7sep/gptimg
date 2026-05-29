import type { Command } from "commander";
import { GptImg } from "../../gptimg.js";
import { MODELS, type ModelKey } from "../../local/models/registry.js";
import { getAbortSignal } from "../abort.js";
import { emit } from "../output.js";

interface InstallOpts {
  force?: boolean;
  recipe?: string;
}

export function registerModel(program: Command): void {
  const model = program
    .command("model")
    .description("Manage local AI model files (download, list).");

  model
    .command("install [name]")
    .description(
      "Download model(s) into the cache (verified against the pinned sha256). " +
        "With no name, installs all known models. --force re-downloads even if cached.",
    )
    .option("--force", "Re-download and replace even if already cached")
    .option("--recipe <path>", "Path to recipe JSON file (for network.modelDownload)")
    .action(async (name: string | undefined, opts: InstallOpts, cmd: Command) => {
      const keys = Object.keys(MODELS) as ModelKey[];
      if (name !== undefined && !keys.includes(name as ModelKey)) {
        cmd.error(`unknown model '${name}'; known: ${keys.join(", ")}`, {
          code: "commander.invalidArgument",
        });
      }
      const targets = name !== undefined ? [name as ModelKey] : keys;
      const sdk = new GptImg();
      const results = [];
      for (const key of targets) {
        results.push(
          await sdk.model.install(key, {
            force: opts.force,
            recipe: opts.recipe,
            signal: getAbortSignal(),
          }),
        );
      }
      emit(results);
    });

  model
    .command("list")
    .description("List known models and whether each is cached.")
    .action(() => {
      const sdk = new GptImg();
      emit(sdk.model.list());
    });
}
