import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertSingleFileAvailable,
  inferStem,
  resolveOutputPath,
  withVerbLogger,
} from "../../src/internal/local-verb.js";
import { LocalOpError } from "../../src/errors.js";

describe("inferStem", () => {
  it("strips the final extension from a basename", () => {
    expect(inferStem("/a/b/foo.png")).toBe("foo");
    expect(inferStem("foo.png")).toBe("foo");
    expect(inferStem("/a/foo.tar.gz")).toBe("foo.tar");
  });

  it("returns the basename unchanged when there is no extension", () => {
    expect(inferStem("/tmp/README")).toBe("README");
  });

  it("treats a leading-dot filename as having no extension", () => {
    // path.basename(".env").lastIndexOf(".") === 0, which is not > 0.
    expect(inferStem("/x/.env")).toBe(".env");
  });
});

describe("assertSingleFileAvailable", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-lv-overwrite-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("allows writing when the target does not exist", () => {
    expect(() =>
      assertSingleFileAvailable(path.join(tmp, "nope.png"), false),
    ).not.toThrow();
  });

  it("throws output.exists when the target exists and overwrite is false", async () => {
    const target = path.join(tmp, "there.png");
    await writeFile(target, "x");
    expect(() => assertSingleFileAvailable(target, false)).toThrowError(
      LocalOpError,
    );
    try {
      assertSingleFileAvailable(target, false);
    } catch (err) {
      expect((err as LocalOpError).code).toBe("output.exists");
      expect((err as Error).message).toContain("--overwrite");
    }
  });

  it("allows overwriting when overwrite is true", async () => {
    const target = path.join(tmp, "there.png");
    await writeFile(target, "x");
    expect(() => assertSingleFileAvailable(target, true)).not.toThrow();
  });
});

describe("resolveOutputPath", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-lv-resolve-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("defaults outDir to the input file's directory", async () => {
    const input = path.join(tmp, "src", "foo.png");
    const out = await resolveOutputPath(
      {},
      { inputForDir: input, outName: "foo-trim.png" },
    );
    expect(out).toBe(path.join(tmp, "src", "foo-trim.png"));
  });

  it("honors an explicit outDir over the input dir", async () => {
    const input = path.join(tmp, "src", "foo.png");
    const outDir = path.join(tmp, "out");
    const out = await resolveOutputPath(
      { outDir },
      { inputForDir: input, outName: "foo-trim.png" },
    );
    expect(out).toBe(path.join(outDir, "foo-trim.png"));
  });

  it("treats an absolute outName as the full path (outDir is ignored)", async () => {
    const input = path.join(tmp, "src", "foo.png");
    const abs = path.join(tmp, "elsewhere", "explicit.png");
    const out = await resolveOutputPath(
      { outDir: path.join(tmp, "ignored"), outName: abs },
      { inputForDir: input, outName: "ignored-default.png" },
    );
    expect(out).toBe(abs);
  });

  it("falls back to process.cwd() when no input is provided (e.g. backplate)", async () => {
    const out = await resolveOutputPath(
      {},
      { outName: "backplate-1024.png" },
    );
    expect(out).toBe(path.join(process.cwd(), "backplate-1024.png"));
  });

  it("creates the resolved outDir (mkdir -p)", async () => {
    const deep = path.join(tmp, "a", "b", "c");
    const out = await resolveOutputPath(
      { outDir: deep },
      { outName: "x.png" },
    );
    expect(out).toBe(path.join(deep, "x.png"));
    // mkdir -p should make the dir writable now:
    await writeFile(out, "x");
  });
});

describe("withVerbLogger", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-lv-logger-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns the body's result on success and the body sees the logger", async () => {
    const logPath = path.join(tmp, "verb.jsonl");
    const result = await withVerbLogger(
      { logDir: tmp },
      "compose",
      { log: logPath },
      async (logger) => {
        await logger.info("resolve", "hello", { x: 1 });
        return { ok: true as const, logPath: logger.handle.path };
      },
    );
    expect(result).toEqual({ ok: true, logPath });
    const lines = (await readFile(logPath, "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({
      verb: "compose",
      level: "info",
      stage: "resolve",
      msg: "hello",
      data: { x: 1 },
    });
  });

  it("logs the thrown error and rethrows it", async () => {
    const logPath = path.join(tmp, "verb.jsonl");
    const err = new LocalOpError("output.exists", "boom");
    await expect(
      withVerbLogger({ logDir: tmp }, "mask", { log: logPath }, async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    const lines = (await readFile(logPath, "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({
      verb: "mask",
      level: "error",
      stage: "error",
      msg: "boom",
      data: { code: "output.exists" },
    });
  });

  it("derives a default log path under ctx.logDir when logArg is undefined", async () => {
    const result = await withVerbLogger(
      { logDir: tmp },
      "combine",
      {},
      async (logger) => {
        await logger.info("resolve", "ok");
        return logger.handle.path;
      },
    );
    expect(result.startsWith(tmp + path.sep)).toBe(true);
    expect(result.endsWith("-gptimg.jsonl")).toBe(true);
  });
});
