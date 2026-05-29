import { Command } from "commander";
import { installSigintHandler } from "./abort.js";
import { emitError } from "./output.js";
import { exitCodeFor } from "./exitCodes.js";
import { registerBackplate } from "./verbs/backplate.js";
import { registerCombine } from "./verbs/combine.js";
import { registerCompose } from "./verbs/compose.js";
import { registerEdit } from "./verbs/edit.js";
import { registerGenerate } from "./verbs/generate.js";
import { registerLayer } from "./verbs/layer.js";
import { registerMask } from "./verbs/mask.js";
import { registerModel } from "./verbs/model.js";
import { registerProfile } from "./verbs/profile.js";
import { registerTrim } from "./verbs/trim.js";
import { registerVision } from "./verbs/vision.js";

function createProgram(): Command {
  const program = new Command();
  program
    .name("gptimg")
    .description(
      "AI image generation, vision, and local mask + compose post-processing.",
    )
    .version("0.1.0")
    .showHelpAfterError()
    .exitOverride();

  registerGenerate(program);
  registerEdit(program);
  registerVision(program);
  registerMask(program);
  registerCompose(program);
  registerCombine(program);
  registerTrim(program);
  registerBackplate(program);
  registerLayer(program);
  registerModel(program);
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
