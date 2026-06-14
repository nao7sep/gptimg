import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/run.js";
import { exitCodeFor } from "../../src/cli/exitCodes.js";
import {
  LocalOpError,
  ProfileError,
  ProviderError,
  RecipeError,
} from "../../src/errors.js";

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
    // --quiet so stderr carries only the error envelope, not progress lines;
    // these tests assert the error/exit contract. Progress is covered separately.
    const code = await runCli(["node", "gptimg", "--quiet", ...args]);
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
  let emptyRecipePath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-cli-"));
    profilePath = path.join(tmp, "profile.json");
    badProviderPath = path.join(tmp, "bad-provider.json");
    emptyRecipePath = path.join(tmp, "empty-recipe.json");
    await writeFile(
      profilePath,
      JSON.stringify({ provider: "openai", apiKey: "test-key" }) + "\n",
    );
    await writeFile(
      badProviderPath,
      JSON.stringify({ provider: "nope", apiKey: "test-key" }) + "\n",
    );
    // A hermetic, existing (but empty) recipe: pins the recipe so tests never
    // read the developer's ~/.gptimg/recipe.json, without itself being the
    // caller-named-missing usage error that those tests are not exercising.
    await writeFile(emptyRecipePath, JSON.stringify({}) + "\n");
    if (process.platform !== "win32") {
      await chmod(profilePath, 0o600);
      await chmod(badProviderPath, 0o600);
    }
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
      "mask",
      "--in",
      fixture("green-disk.png"),
      "--method",
      "nope",
    ]);
    expect(badChoice.code).toBe(2);
    expect(badChoice.stderr).toContain("Allowed choices are chroma, ai");
  });

  it("returns 2 for CLI-owned usage validation", async () => {
    const missingKey = await run(["profile", "set-key"]);
    expect(missingKey.code).toBe(2);
    expect(missingKey.stderr).toContain("Provide the API key via --key");

    const badNumber = await run([
      "mask",
      "--in",
      fixture("green-disk.png"),
      "--border-sample",
      "nope",
    ]);
    expect(badNumber.code).toBe(2);
    expect(badNumber.stderr).toContain("--border-sample: must be a number");
  });

  it("maps SDK argument validation (args.invalid) to exit 2 with a plain message", async () => {
    // These flags pass CLI coercion (they ARE numbers / valid "x,y" points);
    // their semantic bounds live only in the SDK, so the violation is caught
    // mid-verb. It must still read as a usage error: exit 2, a one-line
    // `error:` message on stderr, empty stdout, and no JSON envelope.
    const disk = fixture("green-disk.png");
    const cases: Array<[string, string[], string]> = [
      ["shadow opacity (0..1]", ["shadow", "--in", disk, "--opacity", "5"], "must be in (0..1]"],
      ["shadow spread integer", ["shadow", "--in", disk, "--spread", "1.5"], "must be an integer in [0..1024]"],
      ["shadow offset integer", ["shadow", "--in", disk, "--offset", "1.5,2"], "offset must be integers"],
      ["shadow offset range", ["shadow", "--in", disk, "--offset", "99999,0"], "offset components must be within"],
      ["backplate size positive int", ["backplate", "--from", "#000000", "--to", "#ffffff", "--size", "0"], "must be a positive integer"],
      ["backplate content (0..1]", ["backplate", "--from", "#000000", "--to", "#ffffff", "--content", "5"], "must be in (0..1]"],
      ["backplate radius [0..0.5]", ["backplate", "--from", "#000000", "--to", "#ffffff", "--radius", "0.9"], "must be in [0..0.5]"],
      ["resize to-size zero", ["resize", "--in", disk, "--to-size", "0"], "must be an integer in [1.."],
      ["resize to-size non-integer", ["resize", "--in", disk, "--to-size", "1.5"], "must be an integer in [1.."],
      ["trim margin [0..1]", ["trim", "--in", disk, "--margin", "2"], "must be in [0..1]"],
      ["layer scale positive", ["layer", "--base", disk, "--top", disk, "--scale", "-1"], "must be a positive number"],
      ["mask saturation-ratio (0..1]", ["mask", "--in", disk, "--saturation-ratio", "5"], "must be in (0..1]"],
      ["combine feather radius [0..1024]", ["combine", "feather", "--in", disk, "--radius", "99999"], "must be in [0..1024]"],
    ];

    for (const [name, args, msg] of cases) {
      const result = await run([...args, "--out-dir", tmp]);
      expect(result.code, name).toBe(2);
      expect(result.stdout, name).toBe("");
      expect(result.stderr.trim(), name).toMatch(/^error: /);
      expect(result.stderr, name).toContain(msg);
    }
  });

  it("maps input-precondition usage errors (not args.invalid) to exit 2", async () => {
    // An unsupported option value is a caller mistake, not a runtime failure:
    // it shares the usage contract — exit 2, plain `error:` line, no JSON — even
    // though its code is `vision.detailUnsupported`, not `args.invalid`. This is
    // routed by the shared isUsageError predicate, so it stands in for the whole
    // usage-code set (image.noContent, image.sizeMismatch, …).
    const result = await run([
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
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toMatch(/^error: /);
    expect(result.stderr).toContain("detail");
  });

  it("treats a missing/invalid caller-named profile or recipe as a usage error (exit 2)", async () => {
    // The caller named the path (or wrote the contents); per the conventions
    // that is theirs to fix — usage, not a runtime failure. Exit 2, a plain
    // `error:` line, empty stdout, no JSON envelope.
    const missingProfile = await run([
      "generate",
      "prompt",
      "--profile",
      path.join(tmp, "missing-profile.json"),
      "--recipe",
      emptyRecipePath,
      "--log",
      path.join(tmp, "profile.log"),
    ]);
    expect(missingProfile.code).toBe(2);
    expect(missingProfile.stdout).toBe("");
    expect(missingProfile.stderr.trim()).toMatch(/^error: /);
    expect(missingProfile.stderr).toContain("Profile not found");

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
    expect(recipe.code).toBe(2);
    expect(recipe.stdout).toBe("");
    expect(recipe.stderr.trim()).toMatch(/^error: /);
    expect(recipe.stderr).toContain("Invalid JSON in recipe");
  });

  it("treats a caller-named recipe that does not exist as a usage error (exit 2)", async () => {
    // The caller named --recipe, so a missing file is theirs to fix (and their
    // settings are NOT silently ignored). Contrast: an absent *default* recipe
    // is a no-op, covered by the SDK loadRecipeForCall tests.
    const result = await run([
      "generate",
      "prompt",
      "--profile",
      profilePath,
      "--recipe",
      path.join(tmp, "typo-recipe.json"),
      "--log",
      path.join(tmp, "typo.log"),
    ]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toMatch(/^error: /);
    expect(result.stderr).toContain("Recipe file not found");
  });

  it("treats an unknown provider named in the profile as a usage error (exit 2)", async () => {
    const result = await run([
      "generate",
      "prompt",
      "--profile",
      badProviderPath,
      "--recipe",
      emptyRecipePath,
      "--log",
      path.join(tmp, "provider.log"),
    ]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toMatch(/^error: /);
    expect(result.stderr).toContain("Unknown provider");
  });

  it("returns 3 for a profile read failure (runtime, not the caller's fault)", async () => {
    const profileDir = path.join(tmp, "profile-dir");
    await mkdir(profileDir);
    const clearKey = await run(["profile", "clear-key", "--path", profileDir]);
    expect(clearKey.code).toBe(3);
    expect(parseError(clearKey.stderr).error.code).toBe("profile.readFailed");
  });

  it("an output collision is a usage error (exit 2, plain message, no JSON)", async () => {
    const bp = [
      "backplate", "--from", "#000000", "--to", "#ffffff", "--size", "16",
      "--out-dir", tmp, "--out-name", "collide", "--log", path.join(tmp, "bp.log"),
    ];
    const first = await run(bp);
    expect(first.code).toBe(0);
    const second = await run(bp); // same target, no --overwrite
    expect(second.code).toBe(2);
    expect(second.stdout).toBe("");
    expect(second.stderr.trim()).toMatch(/^error: /);
    expect(second.stderr).toContain("Output exists");
  });

  it("a missing API key is a usage error (exit 2, plain message)", async () => {
    const noKey = path.join(tmp, "nokey.json");
    await writeFile(noKey, JSON.stringify({ provider: "openai" }) + "\n");
    const result = await run([
      "generate", "prompt", "--profile", noKey,
      "--out-dir", tmp, "--log", path.join(tmp, "nokey.log"),
    ]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toMatch(/^error: /);
    expect(result.stderr).toContain("No apiKey resolved");
  });

  // POSIX-only: the file-mode check is skipped on Windows.
  it.skipIf(process.platform === "win32")(
    "an insecure profile file mode is a usage error (exit 2, plain message)",
    async () => {
      const loose = path.join(tmp, "loose.json");
      await writeFile(loose, JSON.stringify({ provider: "openai", apiKey: "sk-test" }) + "\n");
      await chmod(loose, 0o644);
      const result = await run([
        "generate", "prompt", "--profile", loose,
        "--out-dir", tmp, "--log", path.join(tmp, "loose.log"),
      ]);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toMatch(/^error: /);
      expect(result.stderr).toContain("file mode is");
    },
  );

  it("returns 5 for local operation errors", async () => {
    const maskMissing = await run([
      "mask",
      "--in",
      path.join(tmp, "missing.png"),
      "--log",
      path.join(tmp, "mask-missing.log"),
    ]);
    expect(maskMissing.code).toBe(5);
    expect(parseError(maskMissing.stderr).error.type).toBe("localOp");

    const edit = await run([
      "edit",
      "prompt",
      "--in",
      path.join(tmp, "missing-edit.png"),
      "--profile",
      profilePath,
      "--recipe",
      emptyRecipePath,
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
      emptyRecipePath,
      "--log",
      path.join(tmp, "vision.log"),
    ]);
    expect(vision.code).toBe(5);
    expect(parseError(vision.stderr).error.type).toBe("localOp");

    const fileAsDir = path.join(tmp, "file-as-dir");
    await writeFile(fileAsDir, "");
    const badOutDir = await run([
      "mask",
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

  it("a log path that can't be written is announced once and never fails the verb", async () => {
    // Point --log at a directory: opening its parent succeeds but the append
    // fails (EISDIR). Logging must announce the failure and keep running, never
    // crash the verb.
    const logDir = path.join(tmp, "log-as-file");
    await mkdir(logDir);
    const outPath = path.join(tmp, "degraded-mask.png");
    const result = await run([
      "mask",
      "--in",
      fixture("green-disk.png"),
      "--out-name",
      outPath,
      "--overwrite",
      "--log",
      logDir,
    ]);

    // The verb still succeeds and writes its output...
    expect(result.code).toBe(0);
    expect(existsSync(outPath)).toBe(true);
    // ...stdout stays the clean result document (the notice never touches it)...
    const payload = JSON.parse(result.stdout) as { output: string };
    expect(payload.output).toBe(outPath);
    // ...and the logging failure is surfaced on stderr, exactly once.
    expect(result.stderr.split('"message":"log file unavailable"')).toHaveLength(2);
  });

  it("keeps successful mask output on stdout", async () => {
    const outPath = path.join(tmp, "out-mask.png");
    const result = await run([
      "mask",
      "--in",
      fixture("green-disk.png"),
      "--out-name",
      outPath,
      "--log",
      path.join(tmp, "mask.log"),
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as {
      output: string;
    };
    expect(payload.output).toBe(outPath);
    expect(existsSync(outPath)).toBe(true);
  });
});

describe("exit-code mapping (unit)", () => {
  it("maps runtime error domains to distinct nonzero codes", () => {
    expect(exitCodeFor(new ProviderError("provider.requestFailed", "x"))).toBe(4);
    expect(exitCodeFor(new LocalOpError("image.writeFailed", "x"))).toBe(5);
    expect(exitCodeFor(new ProfileError("profile.readFailed", "x"))).toBe(3);
    // output.duplicate is a defensive invariant, not a caller mistake — runtime.
    expect(exitCodeFor(new LocalOpError("output.duplicate", "x"))).toBe(5);
    expect(exitCodeFor(new Error("plain"))).toBe(1);
  });

  it("classifies caller-fault codes as usage (exit 2)", () => {
    const usage = [
      new LocalOpError("args.invalid", "x"),
      new RecipeError("set.invalidExpression", "x"),
      new ProviderError("provider.unknown", "x"),
      new ProfileError("profile.notFound", "x"),
      new RecipeError("recipe.invalidJson", "x"),
      new RecipeError("recipe.validationFailed", "x"),
      new ProfileError("profile.validationFailed", "x"),
      new LocalOpError("output.exists", "x"),
      new LocalOpError("output.staleSiblings", "x"),
      new ProfileError("apiKey.missing", "x"),
      new ProfileError("profile.insecureMode", "x"),
    ];
    for (const e of usage) expect(exitCodeFor(e)).toBe(2);
  });
});
