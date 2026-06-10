import type { Command } from "commander";
import { GptImg } from "../../gptimg.js";
import { MODELS, type ModelKey } from "../../local/models/registry.js";
import type { ModelInstallResult } from "../../types.js";
import { cliCallOptions } from "../progress.js";
import { emit } from "../output.js";

interface InstallOpts {
  force?: boolean;
  recipe?: string;
  log?: string;
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
    .option("--log <path>", "Path to log JSONL file")
    .action(async (name: string | undefined, opts: InstallOpts, cmd: Command) => {
      const keys = Object.keys(MODELS) as ModelKey[];
      if (name !== undefined && !keys.includes(name as ModelKey)) {
        cmd.error(`unknown model '${name}'; known: ${keys.join(", ")}`, {
          code: "commander.invalidArgument",
        });
      }
      const sdk = new GptImg();
      const installOpts = {
        force: opts.force,
        recipe: opts.recipe,
        log: opts.log,
        ...cliCallOptions(),
      };
      // Both paths emit the same `{ installed: [...] }` envelope (sdk-cli §4:
      // one JSON object on stdout). A targeted install returns one model, which
      // the CLI wraps; installAll already returns the wrapper.
      const result: ModelInstallResult =
        name !== undefined
          ? { installed: [await sdk.model.install(name as ModelKey, installOpts)] }
          : await sdk.model.installAll(installOpts);
      emit(result);
    });

  model
    .command("list")
    .description("List known models and whether each is cached.")
    .action(() => {
      const sdk = new GptImg();
      emit(sdk.model.list());
    });
}
