import { Command } from "commander";
import { installSigintHandler } from "./abort.js";
import { emitError } from "./output.js";
import { exitCodeFor } from "./exitCodes.js";
import { registerGenerate } from "./verbs/generate.js";
import { registerEdit } from "./verbs/edit.js";
import { registerVision } from "./verbs/vision.js";
import { registerChroma } from "./verbs/chroma.js";
import { registerProfile } from "./verbs/profile.js";

export function createProgram(): Command {
  const program = new Command();
  program
    .name("gptimg")
    .description(
      "AI image generation, vision, and local chroma-key post-processing.",
    )
    .version("0.1.0")
    .showHelpAfterError()
    .exitOverride();

  registerGenerate(program);
  registerEdit(program);
  registerVision(program);
  registerChroma(program);
  registerProfile(program);

  return program;
}

export async function runCli(argv: string[] = process.argv): Promise<number> {
  installSigintHandler();

  const program = createProgram();

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (err) {
    const e = err as { code?: string; errorType?: string; exitCode?: number };
    if (typeof e.code === "string" && e.code.startsWith("commander.")) {
      return e.exitCode === 0 ? 0 : 2;
    }
    if (e.errorType === "abort" || (err as Error)?.name === "AbortError") {
      return 130;
    }
    emitError(err);
    return exitCodeFor(err);
  }
}
