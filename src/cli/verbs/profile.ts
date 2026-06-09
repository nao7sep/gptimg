import type { Command } from "commander";
import { GptImg } from "../../gptimg.js";
import { emit } from "../output.js";

interface SetKeyOpts {
  key?: string;
  stdin?: boolean;
  path?: string;
}

interface ClearKeyOpts {
  path?: string;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data.trim()));
    process.stdin.on("error", reject);
  });
}

export function registerProfile(program: Command): void {
  const profile = program
    .command("profile")
    .description("Profile management (connection settings and apiKey storage)");

  const setKey = profile
    .command("set-key")
    .description(
      "Set the apiKey in a profile (stored obfuscated; other fields preserved). " +
        "The profile file is written with owner-only permissions (POSIX mode 0600).",
    )
    .option("--key <value>", "API key value (warning: visible in shell history)")
    .option("--stdin", "Read the API key from stdin")
    .option("--path <path>", "Profile file path (default: ~/.gptimg/profile.json)");

  setKey.action(async (opts: SetKeyOpts) => {
    // The CLI only selects the source (which is an invocation concern); the SDK
    // owns the "key must be non-empty" rule, so an empty --key or empty stdin
    // is rejected there, identically for library callers.
    let raw: string | undefined = opts.key;
    if (raw === undefined && opts.stdin) {
      raw = await readStdin();
    }
    if (raw === undefined) {
      setKey.error("Provide the API key via --key <value> or --stdin.", {
        code: "commander.missingArgument",
      });
    }
    const sdk = new GptImg();
    await sdk.profile.setApiKey(raw as string, opts.path ? { path: opts.path } : undefined);
    emit({ ok: true });
  });

  profile
    .command("clear-key")
    .description("Remove stored apiKey from a profile file (no-op if missing)")
    .option("--path <path>", "Profile file path (default: ~/.gptimg/profile.json)")
    .action(async (opts: ClearKeyOpts) => {
      const sdk = new GptImg();
      await sdk.profile.clearApiKey(opts.path ? { path: opts.path } : undefined);
      emit({ ok: true });
    });
}
