import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendLog,
  closeLog,
  createLogger,
  debugEnabled,
  openLog,
  safeLogError,
  type Logger,
} from "../../src/log/index.js";
import type { LogEntry, LogHandle } from "../../src/types.js";
import { captureStderr } from "../helpers/streams.js";

describe("log helpers", () => {
  let tmp: string;
  let file: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-log-"));
    file = path.join(tmp, "nested", "test.log");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("opens, appends redacted JSONL entries with the envelope keys, and closes", async () => {
    const handle = await openLog(file, "generate");
    await appendLog(handle, {
      time: "2026-01-01T00:00:00.000Z",
      level: "info",
      stage: "request",
      message: "hello",
      data: { apiKey: "secret", value: 1 },
    });
    await closeLog(handle);

    const lines = (await readFile(file, "utf-8")).trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      time: "2026-01-01T00:00:00.000Z",
      verb: "generate",
      level: "info",
      stage: "request",
      message: "hello",
      data: { apiKey: "[redacted]", value: 1 },
    });
  });

  it("createLogger writes info, warn, and error entries", async () => {
    const logger = await createLogger(file, "vision");
    await logger.info("resolve", "resolved");
    await logger.warn("retry", "retrying");
    await logger.error("error", "failed");
    await logger.close();

    const lines = (await readFile(file, "utf-8")).trimEnd().split("\n");
    expect(lines.map((line) => JSON.parse(line) as { level: string })).toEqual([
      expect.objectContaining({ verb: "vision", level: "info" }),
      expect.objectContaining({ verb: "vision", level: "warn" }),
      expect.objectContaining({ verb: "vision", level: "error" }),
    ]);
  });

  it("fans out info and warn entries to onEvent, but never error", async () => {
    const seen: { level: string; stage: string; message: string }[] = [];
    const logger = await createLogger(file, "upscale", {
      onEvent: (e) => seen.push({ level: e.level, stage: e.stage, message: e.message }),
    });
    await logger.info("infer", "tile 1/2");
    await logger.warn("retry", "retrying");
    await logger.error("error", "boom");
    await logger.close();

    // Error is a failure the caller learns about via the thrown error, not the
    // progress stream — only info/warn (and debug) are forwarded.
    expect(seen).toEqual([
      { level: "info", stage: "infer", message: "tile 1/2" },
      { level: "warn", stage: "retry", message: "retrying" },
    ]);
    // The file still records all three levels.
    const lines = (await readFile(file, "utf-8")).trimEnd().split("\n");
    expect(lines).toHaveLength(3);
  });

  it("a throwing onEvent never breaks the logging call", async () => {
    const logger = await createLogger(file, "mask", {
      onEvent: () => {
        throw new Error("sink blew up");
      },
    });
    await expect(logger.info("resolve", "ok")).resolves.toBeUndefined();
    await logger.close();
    const lines = (await readFile(file, "utf-8")).trimEnd().split("\n");
    expect(lines).toHaveLength(1);
  });

  it("safeLogError preserves the original path when logging fails", async () => {
    const logger: Pick<Logger, "error"> = {
      error: vi.fn().mockRejectedValue(new Error("disk full")),
    };

    await expect(safeLogError(logger, "original")).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith("error", "original", undefined);
  });
});

describe("debugEnabled", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts 1 and true (case- and space-insensitive) and rejects everything else", () => {
    for (const v of ["1", "true", "TRUE", " True "]) {
      vi.stubEnv("GPTIMG_DEBUG", v);
      expect(debugEnabled(), v).toBe(true);
    }
    for (const v of ["0", "false", "yes", "2", ""]) {
      vi.stubEnv("GPTIMG_DEBUG", v);
      expect(debugEnabled(), v).toBe(false);
    }
    vi.stubEnv("GPTIMG_DEBUG", undefined);
    expect(debugEnabled()).toBe(false);
  });
});

describe("debug gating", () => {
  let tmp: string;
  let file: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-log-debug-"));
    file = path.join(tmp, "session.log");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tmp, { recursive: true, force: true });
  });

  it("does NOT persist debug lines to the file when debug is disabled, but still forwards them live", async () => {
    vi.stubEnv("GPTIMG_DEBUG", undefined);
    const seen: LogEntry[] = [];
    const logger = await createLogger(file, "model", { onEvent: (e) => seen.push(e) });
    await logger.debug("download", "prog.bin 50%");
    await logger.info("download", "downloaded prog.bin");
    await logger.close();

    // Live stream sees the debug tick (sdk-toolkit §6); the disk log does not.
    expect(seen.map((e) => e.level)).toEqual(["debug", "info"]);
    const lines = (await readFile(file, "utf-8")).trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).level).toBe("info");
  });

  it("persists debug lines to the file when debug is enabled", async () => {
    vi.stubEnv("GPTIMG_DEBUG", "1");
    const logger = await createLogger(file, "model");
    await logger.debug("download", "prog.bin 50%");
    await logger.close();

    const lines = (await readFile(file, "utf-8")).trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).level).toBe("debug");
  });
});

describe("logging fallback when the file can't be written", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-log-fallback-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("surfaces the failure once through the sink and keeps running — never throwing or printing", async () => {
    // The log's parent is a *file*, so mkdir of the dir fails (ENOTDIR).
    const blocker = path.join(tmp, "blocker");
    await writeFile(blocker, "not a dir");
    const logPath = path.join(blocker, "logs", "session.log");
    const seen: LogEntry[] = [];
    const onEvent = (e: LogEntry): void => {
      seen.push(e);
    };

    const chunks = await captureStderr(async () => {
      const handle = await openLog(logPath, "mask", onEvent);
      // Never throws, even though no file could be opened.
      await expect(
        appendLog(handle, { level: "info", stage: "resolve", message: "still works" }, onEvent),
      ).resolves.toBeUndefined();
      await expect(
        appendLog(handle, { level: "info", stage: "write", message: "still works again" }, onEvent),
      ).resolves.toBeUndefined();
    });

    expect(existsSync(logPath)).toBe(false);
    // The failure is surfaced exactly once, through the caller's sink — a valid warn LogEntry.
    const notices = seen.filter((e) => e.message === "log file unavailable");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ level: "warn", verb: "mask", stage: "log" });
    expect((notices[0]!.data as { path: string }).path).toBe(logPath);
    // The data events still reach the live sink, and the SDK prints nothing.
    expect(seen.some((e) => e.message === "still works")).toBe(true);
    expect(chunks.join("")).toBe("");
  });

  it("surfaces a single notice through the sink when the append itself fails, never printing", async () => {
    // A handle whose path is a directory: opening is fine, appendFile fails (EISDIR).
    const asDir = path.join(tmp, "is-a-dir");
    await mkdir(asDir);
    const handle: LogHandle = { path: asDir, verb: "compose" };
    const seen: LogEntry[] = [];
    const onEvent = (e: LogEntry): void => {
      seen.push(e);
    };

    const chunks = await captureStderr(async () => {
      for (let i = 0; i < 3; i++) {
        await expect(
          appendLog(handle, { level: "warn", stage: "retry", message: `retry ${i}` }, onEvent),
        ).resolves.toBeUndefined();
      }
    });

    // Three failing appends, one notice — and the retries themselves still reach the sink.
    expect(seen.filter((e) => e.message === "log file unavailable")).toHaveLength(1);
    expect(seen.filter((e) => e.stage === "retry")).toHaveLength(3);
    expect(chunks.join("")).toBe("");
  });

  it("delivers each event to the live sink and surfaces one notice, never printing", async () => {
    // The SDK never falls back to a stream (§4): the failure and every event flow
    // through the sink only, never duplicated onto stderr.
    const asDir = path.join(tmp, "dir-as-log");
    await mkdir(asDir);
    const seen: LogEntry[] = [];

    const chunks = await captureStderr(async () => {
      const logger = await createLogger(asDir, "backplate", { onEvent: (e) => seen.push(e) });
      await logger.info("resolve", "hello");
      await logger.info("write", "world");
      await logger.close();
    });

    // The data events reached the live sink, once each.
    expect(seen.filter((e) => e.message === "hello")).toHaveLength(1);
    expect(seen.filter((e) => e.message === "world")).toHaveLength(1);
    // The failure is surfaced once through the same sink, not to stderr.
    expect(seen.filter((e) => e.message === "log file unavailable")).toHaveLength(1);
    expect(chunks.join("")).toBe("");
  });
});
