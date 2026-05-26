import type { Command } from "commander";
import { GptImg } from "../../gptimg.js";
import { addAiCommonOptions } from "../options.js";
import { emit } from "../output.js";

interface EditCliOpts {
  in: string;
  mask?: string;
  profile?: string;
  recipe?: string;
  log?: string;
  outDir?: string;
  outName?: string;
  set?: string[];
  patch?: string;
  overwrite?: boolean;
}

export function registerEdit(program: Command): void {
  const cmd = program
    .command("edit")
    .description("Edit an existing image based on a text prompt")
    .argument("<prompt>", "Text prompt describing the edit")
    .requiredOption("--in <path>", "Input image path")
    .option("--mask <path>", "Optional mask image path");

  addAiCommonOptions(cmd);

  cmd.action(async (prompt: string, opts: EditCliOpts) => {
    const sdk = new GptImg();
    const result = await sdk.edit({
      prompt,
      in: opts.in,
      mask: opts.mask,
      profile: opts.profile,
      recipe: opts.recipe,
      log: opts.log,
      outDir: opts.outDir,
      outName: opts.outName,
      set: opts.set,
      patch: opts.patch,
      overwrite: opts.overwrite,
    });
    emit(result);
  });
}
