import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { homedir, tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureOutputDir, writeOutputBytes } from "../../src/internal/output-files.ts";
import { defaultModelsDir } from "../../src/internal/resource-home.ts";
import { defaultStem, utcTimestamp } from "../../src/internal/paths.ts";

describe("internal paths", () => {
  it("names default stems by second and ID", () => {
    expect(defaultStem("20260102-030405-utc", "a1b2c3")).toBe("20260102-030405-utc-a1b2c3-gptimg");
  });

  it("gives calls started in the same second distinct default stems", () => {
    const ts = "20260102-030405-utc";
    const stems = new Set(Array.from({ length: 1000 }, () => defaultStem(ts)));
    expect(stems.size).toBe(1000);
    for (const stem of stems) expect(stem).toMatch(/^20260102-030405-utc-[0-9a-z]{6}-gptimg$/);
    expect(defaultStem()).toMatch(/^\d{8}-\d{6}-utc-[0-9a-z]{6}-gptimg$/);
  });

  it("formats second-precision UTC filename stamps, zero-padded", () => {
    expect(utcTimestamp(new Date("2026-01-02T03:04:05.967Z"))).toBe("20260102-030405-utc");
  });
});

describe("the SDK's own resource folder", () => {
  it("defaults models to ~/.gptimgsdk/models, never the app's ~/.gptimg", () => {
    expect(defaultModelsDir()).toBe(path.join(homedir(), ".gptimgsdk", "models"));
    expect(defaultModelsDir()).not.toContain(`${path.sep}.gptimg${path.sep}`);
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
      name: "GptImgError",
      kind: "unavailable",
      subject: fileAsDir,
      code: expect.stringMatching(/^fs\./),
    });
  });
});
