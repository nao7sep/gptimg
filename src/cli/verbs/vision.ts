import type { Command } from "commander";
import { GptImg } from "../../gptimg.js";
import { cliCallOptions } from "../progress.js";
import { addAiCommonOptions, collectMultiInput } from "../options.js";
import { emit } from "../output.js";

interface VisionCliOpts {
  in?: string[];
  check: string;
  profile?: string;
  recipe?: string;
  log?: string;
  outDir?: string;
  outName?: string;
  set?: string[];
  overwrite?: boolean;
}

export function registerVision(program: Command): void {
  const cmd = program
    .command("vision")
    .description("Run a structured verification check against one or more images")
    .requiredOption(
      "--in <path>",
      "Image path (repeatable)",
      collectMultiInput,
    )
    .requiredOption("--check <text>", "Criterion to verify");

  addAiCommonOptions(cmd);
  cmd.option("--overwrite", "Overwrite an existing sidecar at the resolved stem");

  cmd.action(async (opts: VisionCliOpts) => {
    if (!opts.in?.length) {
      cmd.error("--in is required (at least one)", {
        code: "commander.missingMandatoryOptionValue",
      });
    }
    const inputs = opts.in as string[];
    const sdk = new GptImg();
    const result = await sdk.vision(
      {
        in: inputs.length === 1 ? inputs[0]! : inputs,
        check: opts.check,
        profile: opts.profile,
        recipe: opts.recipe,
        log: opts.log,
        outDir: opts.outDir,
        outName: opts.outName,
        set: opts.set,
        overwrite: opts.overwrite,
      },
      cliCallOptions(),
    );
    emit(result);
  });
}
