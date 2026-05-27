import type { Command } from "commander";
import { GptImg } from "../../gptimg.js";
import { getAbortSignal } from "../abort.js";
import { addAiCommonOptions, collectMultiInput } from "../options.js";
import { emit } from "../output.js";

interface VisionCliOpts {
  in: string[];
  check: string;
  profile?: string;
  recipe?: string;
  log?: string;
  outDir?: string;
  outName?: string;
  set?: string[];
  patch?: string;
}

export function registerVision(program: Command): void {
  const cmd = program
    .command("vision")
    .description("Run a structured verification check against one or more images")
    .requiredOption(
      "--in <path>",
      "Image path (repeatable)",
      collectMultiInput,
      [] as string[],
    )
    .requiredOption("--check <text>", "Criterion to verify");

  addAiCommonOptions(cmd);

  cmd.action(async (opts: VisionCliOpts) => {
    if (opts.in.length === 0) {
      throw new Error("--in is required (at least one)");
    }
    const sdk = new GptImg();
    const result = await sdk.vision(
      {
        in: opts.in.length === 1 ? opts.in[0]! : opts.in,
        check: opts.check,
        profile: opts.profile,
        recipe: opts.recipe,
        log: opts.log,
        outDir: opts.outDir,
        outName: opts.outName,
        set: opts.set,
        patch: opts.patch,
      },
      { signal: getAbortSignal() },
    );
    emit(result);
  });
}
