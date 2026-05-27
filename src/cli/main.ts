import { runCli } from "./run.js";

async function main(): Promise<void> {
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
