import { chmodSync, existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { homedir, tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureOutputDir, writeOutputBytes } from "../../src/internal/output-files.js";
import {
  defaultLogDir,
  defaultLogPath,
  defaultOutDir,
  defaultProfileDir,
  defaultProfilePath,
  defaultRecipePath,
  defaultStem,
  ensureSecureProfileRoot,
  resolveDirOption,
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
    expect(defaultStem("20260102-030405-067-utc", "a1b2c3")).toBe("20260102-030405-067-utc-a1b2c3-gptimg");
  });

  it("gives calls started in the same millisecond distinct default stems", () => {
    const ts = "20260102-030405-067-utc";
    const stems = new Set(Array.from({ length: 1000 }, () => defaultStem(ts)));
    expect(stems.size).toBe(1000);
    for (const stem of stems) expect(stem).toMatch(/^20260102-030405-067-utc-[0-9a-z]{6}-gptimg$/);
    expect(defaultStem()).toMatch(/^\d{8}-\d{6}-\d{3}-utc-[0-9a-z]{6}-gptimg$/);
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

describe("defaultProfileDir (GPTIMG_DATA_DIR)", () => {
  // The relocation override is the one path seam (per the storage-path
  // convention): set it, read it back, and always restore so it cannot leak
  // into other tests in this process. We never reach into a private setter.
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.GPTIMG_DATA_DIR;
    delete process.env.GPTIMG_DATA_DIR;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.GPTIMG_DATA_DIR;
    else process.env.GPTIMG_DATA_DIR = prev;
  });

  it("defaults the storage root to ~/.gptimg when GPTIMG_DATA_DIR is unset", () => {
    // (cleared in beforeEach)
    expect(defaultProfileDir()).toBe(path.join(homedir(), ".gptimg"));
  });

  it("relocates the whole root when GPTIMG_DATA_DIR points at an absolute dir", () => {
    const root = path.join(tmpdir(), "gptimg-home-abs");
    process.env.GPTIMG_DATA_DIR = root;
    const profileDir = defaultProfileDir();

    // The root moved, and every derived subpath hangs off the relocated root.
    expect(profileDir).toBe(root);
    expect(defaultProfilePath(profileDir)).toBe(path.join(root, "profile.json"));
    expect(defaultRecipePath(profileDir)).toBe(path.join(root, "recipe.json"));
    expect(defaultLogDir(profileDir)).toBe(path.join(root, "logs"));
  });

  it("resolves a relative GPTIMG_DATA_DIR against HOME, never the working directory", () => {
    process.env.GPTIMG_DATA_DIR = "custom-root";
    // Resolved against homedir(), not process.cwd() — the override can never
    // reintroduce a cwd dependence.
    expect(defaultProfileDir()).toBe(path.resolve(homedir(), "custom-root"));
    expect(defaultProfileDir()).not.toBe(path.resolve(process.cwd(), "custom-root"));
  });

  it("throws rather than silently falling back when GPTIMG_DATA_DIR expands to empty", () => {
    // ${GPTIMG_UNSET_xxx} references an unset variable, so the value expands to
    // the empty string — an unusable root, which is a startup error, not a
    // silent fallback to ~/.gptimg.
    process.env.GPTIMG_DATA_DIR = "${GPTIMG_DEFINITELY_UNSET_VAR_42}";
    expect(() => defaultProfileDir()).toThrow();
    expect(() => defaultProfileDir()).toThrowError(/expands to an empty path/);
  });
});

describe("resolveDirOption", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("expands ~ and environment references and anchors a relative path at home", () => {
    vi.stubEnv("GPTIMG_TEST_ROOT", path.join(tmpdir(), "root"));
    expect(resolveDirOption("~/profiles", "profileDir")).toBe(path.join(homedir(), "profiles"));
    expect(resolveDirOption("~\\profiles", "profileDir")).toBe(path.join(homedir(), "profiles"));
    expect(resolveDirOption("$GPTIMG_TEST_ROOT/p", "profileDir")).toBe(path.join(tmpdir(), "root", "p"));
    expect(resolveDirOption("%GPTIMG_TEST_ROOT%/logs", "logDir")).toBe(path.join(tmpdir(), "root", "logs"));
    expect(resolveDirOption("profiles", "profileDir")).toBe(path.resolve(homedir(), "profiles"));
    expect(resolveDirOption(path.join(tmpdir(), "abs"), "logDir")).toBe(path.join(tmpdir(), "abs"));
  });

  it("refuses an option that expands to an empty path", () => {
    vi.stubEnv("GPTIMG_TEST_ROOT", undefined);
    expect(() => resolveDirOption("${GPTIMG_TEST_ROOT}", "logDir")).toThrow(
      expect.objectContaining({ code: "profile.invalidHome", message: expect.stringContaining("logDir") }),
    );
  });
});

describe("ensureSecureProfileRoot", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-root-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("creates a fresh root owner-only (0700)", () => {
    const root = path.join(tmp, "profile-root");
    ensureSecureProfileRoot(root);
    expect(existsSync(root)).toBe(true);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("tightens an existing broader root to 0700", () => {
    const root = path.join(tmp, "existing-root");
    ensureSecureProfileRoot(root);
    chmodSync(root, 0o755);
    expect(statSync(root).mode & 0o777).toBe(0o755);

    ensureSecureProfileRoot(root);
    expect(statSync(root).mode & 0o777).toBe(0o700);
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
    await writeOutputBytes(file, new Uint8Array([1, 2, 3]), false);

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
