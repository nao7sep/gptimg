import { runCli } from "./run.js";
import { startCliSession } from "./session.js";

async function main(): Promise<void> {
  startCliSession(process.argv);
  const code = await runCli(process.argv);
  if (code !== 0) {
    process.exitCode = code;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    err instanceof Error ? `${err.stack ?? err.message}\n` : `${String(err)}\n`,
  );
  process.exitCode = 1;
});
