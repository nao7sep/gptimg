import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

describe("published CLI entrypoint", () => {
  it("runs the built dist CLI through bin/gptimg.js", async () => {
    await execFileAsync("npm", ["run", "build"], { cwd: ROOT });
    const pkg = JSON.parse(
      await readFile(path.join(ROOT, "package.json"), "utf-8"),
    ) as { version: string };

    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(ROOT, "bin", "gptimg.js"), "--version"],
      { cwd: ROOT },
    );

    expect(stdout.trim()).toBe(pkg.version);
  }, 120_000);
});
