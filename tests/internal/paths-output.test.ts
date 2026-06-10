import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureOutputDir, writeOutputBytes } from "../../src/internal/output-files.js";
import {
  defaultLogDir,
  defaultLogPath,
  defaultOutDir,
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
