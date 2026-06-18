import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { homedir, tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureOutputDir, writeOutputBytes } from "../../src/internal/output-files.js";
import {
  defaultLogDir,
  defaultLogPath,
  defaultOutDir,
  defaultProfileDir,
  defaultProfilePath,
  defaultRecipePath,
  defaultStem,
  utcTimestamp,
  utcTimestampMs,
} from "../../src/internal/paths.js";

describe("internal paths", () => {
  it("builds default paths from a profile directory", () => {
    const profileDir = path.join("tmp", "profile");

    expect(defaultProfilePath(profileDir)).toBe(path.join(profileDir, "profile.json"));
    expect(defaultRecipePath(profileDir)).toBe(path.join(profileDir, "recipe.json"));
    expect(defaultLogDir(profileDir)).toBe(path.join(profileDir, "logs"));
    expect(defaultOutDir(profileDir)).toBe(path.join(profileDir, "output"));
    expect(defaultLogPath(path.join(profileDir, "logs"), "20260102-030405-utc")).toBe(
      path.join(profileDir, "logs", "20260102-030405-utc.log"),
    );
    expect(defaultStem("20260102-030405-utc")).toBe("20260102-030405-utc-gptimg");
  });

  it("formats UTC timestamps with the required suffix", () => {
    expect(utcTimestamp(new Date("2026-01-02T03:04:05Z"))).toBe(
      "20260102-030405-utc",
    );
  });

  it("formats millisecond UTC timestamps with the -fff exception, zero-padded", () => {
    expect(utcTimestampMs(new Date("2026-01-02T03:04:05.067Z"))).toBe(
      "20260102-030405-067-utc",
    );
    // A whole-second instant still carries an explicit 000 millisecond part.
    expect(utcTimestampMs(new Date("2026-01-02T03:04:05Z"))).toBe(
      "20260102-030405-000-utc",
    );
  });
});

describe("defaultProfileDir (GPTIMG_HOME)", () => {
  // The relocation override is the one path seam (per the storage-path
  // convention): set it, read it back, and always restore so it cannot leak
  // into other tests in this process. We never reach into a private setter.
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.GPTIMG_HOME;
    delete process.env.GPTIMG_HOME;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.GPTIMG_HOME;
    else process.env.GPTIMG_HOME = prev;
  });

  it("defaults the storage root to ~/.gptimg when GPTIMG_HOME is unset", () => {
    // (cleared in beforeEach)
    expect(defaultProfileDir()).toBe(path.join(homedir(), ".gptimg"));
  });

  it("relocates the whole root when GPTIMG_HOME points at an absolute dir", () => {
    const root = path.join(tmpdir(), "gptimg-home-abs");
    process.env.GPTIMG_HOME = root;
    const profileDir = defaultProfileDir();

    // The root moved, and every derived subpath hangs off the relocated root.
    expect(profileDir).toBe(root);
    expect(defaultProfilePath(profileDir)).toBe(path.join(root, "profile.json"));
    expect(defaultRecipePath(profileDir)).toBe(path.join(root, "recipe.json"));
    expect(defaultLogDir(profileDir)).toBe(path.join(root, "logs"));
  });

  it("resolves a relative GPTIMG_HOME against HOME, never the working directory", () => {
    process.env.GPTIMG_HOME = "custom-root";
    // Resolved against homedir(), not process.cwd() — the override can never
    // reintroduce a cwd dependence.
    expect(defaultProfileDir()).toBe(path.resolve(homedir(), "custom-root"));
    expect(defaultProfileDir()).not.toBe(path.resolve(process.cwd(), "custom-root"));
  });

  it("throws rather than silently falling back when GPTIMG_HOME expands to empty", () => {
    // ${GPTIMG_UNSET_xxx} references an unset variable, so the value expands to
    // the empty string — an unusable root, which is a startup error, not a
    // silent fallback to ~/.gptimg.
    process.env.GPTIMG_HOME = "${GPTIMG_DEFINITELY_UNSET_VAR_42}";
    expect(() => defaultProfileDir()).toThrow();
    expect(() => defaultProfileDir()).toThrowError(/expands to an empty path/);
  });
});

describe("output file helpers", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-output-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("creates output directories and writes bytes", async () => {
    const outDir = path.join(tmp, "nested");
    const file = path.join(outDir, "out.bin");

    await ensureOutputDir(outDir);
    await writeOutputBytes(file, new Uint8Array([1, 2, 3]));

    expect(existsSync(outDir)).toBe(true);
    await expect(readFile(file)).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  it("reports output directory creation errors", async () => {
    const fileAsDir = path.join(tmp, "file");
    await writeFile(fileAsDir, "");

    await expect(ensureOutputDir(fileAsDir)).rejects.toMatchObject({
      errorType: "localOp",
      code: "output.mkdirFailed",
    });
  });
});
