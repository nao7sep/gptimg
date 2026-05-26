import type { Command } from "commander";
import { GptImg } from "../../gptimg.js";
import { addAiCommonOptions } from "../options.js";
import { emit } from "../output.js";

interface GenerateCliOpts {
  profile?: string;
  recipe?: string;
  log?: string;
  outDir?: string;
  outName?: string;
  set?: string[];
  patch?: string;
  overwrite?: boolean;
}

export function registerGenerate(program: Command): void {
  const cmd = program
    .command("generate")
    .description("Generate one or more images from a text prompt")
    .argument("<prompt>", "Text prompt for image generation");

  addAiCommonOptions(cmd);

  cmd.action(async (prompt: string, opts: GenerateCliOpts) => {
    const sdk = new GptImg();
    const result = await sdk.generate({
      prompt,
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
