import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/run.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "fixtures");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function fixture(name: string): string {
  return path.join(FIXTURES, name);
}

function captureChunk(chunk: unknown): string {
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf-8");
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf-8");
  return String(chunk);
}

async function run(args: string[]): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;

  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    stdout += captureChunk(chunk);
    const callback = rest.find((x) => typeof x === "function") as
      | (() => void)
      | undefined;
    callback?.();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    stderr += captureChunk(chunk);
    const callback = rest.find((x) => typeof x === "function") as
      | (() => void)
      | undefined;
    callback?.();
    return true;
  }) as typeof process.stderr.write;

  try {
    const code = await runCli(["node", "gptimg", ...args]);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

function parseError(stderr: string): {
  error: { type: string; code: string; message: string };
} {
  return JSON.parse(stderr) as {
    error: { type: string; code: string; message: string };
  };
}

describe("CLI exit codes", () => {
  let tmp: string;
  let profilePath: string;
  let badProviderPath: string;
  let missingRecipePath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-cli-"));
    profilePath = path.join(tmp, "profile.json");
    badProviderPath = path.join(tmp, "bad-provider.json");
    missingRecipePath = path.join(tmp, "missing-recipe.json");
    await writeFile(
      profilePath,
      JSON.stringify({ provider: "openai", apiKey: "test-key" }) + "\n",
    );
    await writeFile(
      badProviderPath,
      JSON.stringify({ provider: "nope", apiKey: "test-key" }) + "\n",
    );
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns 0 for help and version", async () => {
    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: gptimg");

    const version = await run(["--version"]);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toBe("0.1.0");
  });

  it("returns 2 for Commander usage errors", async () => {
    const missingArg = await run(["generate"]);
    expect(missingArg.code).toBe(2);
    expect(missingArg.stderr).toContain("missing required argument 'prompt'");

    const badChoice = await run([
      "chroma",
      "--in",
      fixture("green-disk.png"),
      "--mode",
      "bad",
    ]);
    expect(badChoice.code).toBe(2);
    expect(badChoice.stderr).toContain("Allowed choices are outer, all");
  });

  it("returns 2 for CLI-owned usage validation", async () => {
    const missingKey = await run(["profile", "set-key"]);
    expect(missingKey.code).toBe(2);
    expect(missingKey.stderr).toContain("No API key provided");

    const badNumber = await run([
      "chroma",
      "--in",
      fixture("green-disk.png"),
      "--border-sample",
      "nope",
    ]);
    expect(badNumber.code).toBe(2);
    expect(badNumber.stderr).toContain("--border-sample: not a number");
  });

  it("returns 3 for profile and recipe errors", async () => {
    const profile = await run([
      "generate",
      "prompt",
      "--profile",
      path.join(tmp, "missing-profile.json"),
      "--recipe",
      missingRecipePath,
      "--log",
      path.join(tmp, "profile.log"),
    ]);
    expect(profile.code).toBe(3);
    expect(parseError(profile.stderr).error.type).toBe("profile");

    const badRecipe = path.join(tmp, "bad-recipe.json");
    await writeFile(badRecipe, "{bad json");
    const recipe = await run([
      "generate",
      "prompt",
      "--profile",
      profilePath,
      "--recipe",
      badRecipe,
      "--log",
      path.join(tmp, "recipe.log"),
    ]);
    expect(recipe.code).toBe(3);
    expect(parseError(recipe.stderr).error.type).toBe("recipe");

    const profileDir = path.join(tmp, "profile-dir");
    await mkdir(profileDir);
    const clearKey = await run([
      "profile",
      "clear-key",
      "--path",
      profileDir,
    ]);
    expect(clearKey.code).toBe(3);
    expect(parseError(clearKey.stderr).error.code).toBe("profile.readFailed");
  });

  it("returns 4 for provider errors", async () => {
    const result = await run([
      "generate",
      "prompt",
      "--profile",
      badProviderPath,
      "--recipe",
      missingRecipePath,
      "--log",
      path.join(tmp, "provider.log"),
    ]);
    expect(result.code).toBe(4);
    expect(parseError(result.stderr).error.type).toBe("provider");
  });

  it("returns 5 for local operation errors", async () => {
    const inspect = await run([
      "inspect",
      "--in",
      path.join(tmp, "missing.png"),
      "--log",
      path.join(tmp, "inspect.log"),
    ]);
    expect(inspect.code).toBe(5);
    expect(parseError(inspect.stderr).error.type).toBe("localOp");

    const edit = await run([
      "edit",
      "prompt",
      "--in",
      path.join(tmp, "missing-edit.png"),
      "--profile",
      profilePath,
      "--recipe",
      missingRecipePath,
      "--log",
      path.join(tmp, "edit.log"),
    ]);
    expect(edit.code).toBe(5);
    expect(parseError(edit.stderr).error.type).toBe("localOp");

    const vision = await run([
      "vision",
      "--in",
      path.join(tmp, "missing-vision.png"),
      "--check",
      "anything",
      "--profile",
      profilePath,
      "--recipe",
      missingRecipePath,
      "--log",
      path.join(tmp, "vision.log"),
    ]);
    expect(vision.code).toBe(5);
    expect(parseError(vision.stderr).error.type).toBe("localOp");

    const unsupportedDetail = await run([
      "vision",
      "--in",
      fixture("green-disk.png"),
      "--check",
      "is this a green disk?",
      "--profile",
      profilePath,
      "--log",
      path.join(tmp, "vision-detail.log"),
      "--set",
      "detail=original",
    ]);
    expect(unsupportedDetail.code).toBe(5);
    expect(parseError(unsupportedDetail.stderr).error).toMatchObject({
      type: "localOp",
      code: "vision.detailUnsupported",
    });

    const logDir = path.join(tmp, "log-dir");
    await mkdir(logDir);
    const badLog = await run([
      "inspect",
      "--in",
      fixture("green-disk.png"),
      "--log",
      logDir,
    ]);
    expect(badLog.code).toBe(5);
    expect(parseError(badLog.stderr).error.code).toBe("log.writeFailed");

    const fileAsDir = path.join(tmp, "file-as-dir");
    await writeFile(fileAsDir, "");
    const badOutDir = await run([
      "chroma",
      "--in",
      fixture("green-disk.png"),
      "--out-dir",
      fileAsDir,
      "--log",
      path.join(tmp, "bad-out-dir.log"),
    ]);
    expect(badOutDir.code).toBe(5);
    expect(parseError(badOutDir.stderr).error.code).toBe("output.mkdirFailed");
  });

  it("keeps successful chroma output on stdout", async () => {
    const outPath = path.join(tmp, "out.png");
    const maskPath = path.join(tmp, "mask.png");
    const result = await run([
      "chroma",
      "--in",
      fixture("green-disk.png"),
      "--out-name",
      outPath,
      "--mask-name",
      maskPath,
      "--log",
      path.join(tmp, "chroma.log"),
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as {
      outputs: { image: string; mask: string | null };
    };
    expect(payload.outputs.image).toBe(outPath);
    expect(payload.outputs.mask).toBe(maskPath);
    expect(existsSync(outPath)).toBe(true);
    expect(existsSync(maskPath)).toBe(true);
  });
});
