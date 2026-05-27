import { Command } from "commander";
import { installSigintHandler } from "./abort.js";
import { emitError } from "./output.js";
import { exitCodeFor } from "./exitCodes.js";
import { registerGenerate } from "./verbs/generate.js";
import { registerEdit } from "./verbs/edit.js";
import { registerVision } from "./verbs/vision.js";
import { registerChroma } from "./verbs/chroma.js";
import { registerInspect } from "./verbs/inspect.js";
import { registerProfile } from "./verbs/profile.js";

async function main(): Promise<void> {
  installSigintHandler();

  const program = new Command();
  program
    .name("gptimg")
    .description(
      "AI image generation, vision, and local chroma-key post-processing.",
    )
    .version("0.1.0")
    .showHelpAfterError();

  registerGenerate(program);
  registerEdit(program);
  registerVision(program);
  registerChroma(program);
  registerInspect(program);
  registerProfile(program);

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    const e = err as { code?: string; errorType?: string };
    // Commander usage errors carry "commander.*" codes.
    if (typeof e.code === "string" && e.code.startsWith("commander.")) {
      // Commander already printed help/usage. Exit with usage code.
      if (e.code === "commander.helpDisplayed" || e.code === "commander.version") {
        process.exit(0);
      }
      process.exit(2);
    }
    // SIGINT-initiated cancellation: exit cleanly without dumping a noisy
    // error JSON. The CLI already saw the user's Ctrl-C.
    if (e.errorType === "abort" || (err as Error)?.name === "AbortError") {
      process.exit(130);
    }
    emitError(err);
    process.exit(exitCodeFor(err));
  }
}

main();
