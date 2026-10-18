import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/log/index.ts";
import { GptImg } from "../../src/index.ts";
import type { LogEntry } from "../../src/types.ts";
import { captureStderr } from "../helpers/streams.ts";

const execFileAsync = promisify(execFile);

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

  it("writes JSONL entries with the envelope keys and data as given", async () => {
    const logger = await createLogger(file, "generate");
    await logger.info("request", "hello", { apiKey: "secret", value: 1 });
    await logger.close();

    const lines = (await readFile(file, "utf-8")).trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      verb: "generate",
      level: "info",
      stage: "request",
      message: "hello",
      data: { apiKey: "secret", value: 1 },
    });
  });

  it("writes no file without a path, while events still reach onEvent", async () => {
    const seen: LogEntry[] = [];
    const logger = await createLogger(null, "mask", { onEvent: (e) => seen.push(e) });
    await logger.info("resolve", "no file");
    await logger.close();
    expect(logger.handle.path).toBeNull();
    expect(seen.map((e) => e.message)).toEqual(["no file"]);
  });

  it("reports countable work to onProgress, throttled, always with the final count", async () => {
    const updates: Array<{ done: number; total: number }> = [];
    const logger = await createLogger(null, "upscale", { onProgress: (u) => updates.push({ done: u.done, total: u.total }) });
    for (let i = 1; i <= 50; i++) logger.progress("infer", i, 50, "tiles");
    await logger.close();
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates.length).toBeLessThan(50);
    expect(updates.at(-1)).toEqual({ done: 50, total: 50 });
  });

  it("masks short query credentials without corrupting JSON values, keys or escapes", async () => {
    const seen: LogEntry[] = [];
    const logger = await createLogger(file, "generate", { onEvent: (event) => seen.push(event) });
    for (const credential of ["1", "true", "null", "secret\\\"value"]) logger.addCredential(credential);
    const data = { attempt: 1, enabled: true, absent: null, trueKey: "unchanged", nested: ["secret\\\"value", "https://example.test/?x=1&flag=true&empty=null"] };
    await logger.warn("retry", "retry", data);
    await logger.close();
    const entry = JSON.parse((await readFile(file, "utf8")).trim()) as LogEntry;
    expect(entry.data).toEqual({ attempt: 1, enabled: true, absent: null, trueKey: "unchanged", nested: ["[REDACTED]", "https://example.test/?x=[REDACTED]&flag=[REDACTED]&empty=[REDACTED]"] });
    expect(seen).toEqual([entry]);
    expect(data.nested[0]).toBe("secret\\\"value");
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

  it("fans out every entry to onEvent, error included", async () => {
    const seen: { level: string; stage: string; message: string }[] = [];
    const logger = await createLogger(file, "upscale", {
      onEvent: (e) => seen.push({ level: e.level, stage: e.stage, message: e.message }),
    });
    const info = logger.info("infer", "tile 1/2");
    expect(seen).toEqual([{ level: "info", stage: "infer", message: "tile 1/2" }]);
    await info;
    await logger.warn("retry", "retrying");
    await logger.error("error", "boom");
    await logger.close();

    // Every event reaches the hook, error included (sdk-conventions).
    expect(seen).toEqual([
      { level: "info", stage: "infer", message: "tile 1/2" },
      { level: "warn", stage: "retry", message: "retrying" },
      { level: "error", stage: "error", message: "boom" },
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

  it.each([
    ["async-progress", "a rejected async progress sink leaves public peers successful"],
    ["thenable-progress", "a rejecting thenable progress sink is observed and contained"],
    ["async-notice", "a rejected async log-unavailable notice leaves public peers successful"],
    ["pending-progress", "an unresolved progress sink never delays public operation settlement"],
  ])("%s: %s without process-global failures", async (scenario) => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      fileURLToPath(new URL("../helpers/progress-process.ts", import.meta.url)), scenario, tmp,
    ], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      // Exercise Node's default rejection policy rather than inheriting a
      // caller's NODE_OPTIONS that might suppress unhandled rejections.
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({ outputs: 2, events: scenario === "async-notice" ? 3 : 2 });
    if (scenario === "pending-progress") expect(JSON.parse(stdout).pendingAtFinish).toBe(true);
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

  it("does NOT persist debug lines to the file unless asked, but still forwards them live", async () => {
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

  it("persists debug lines to the file when the log option asks for them", async () => {
    const logger = await createLogger(file, "model", { debug: true });
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
      const logger = await createLogger(logPath, "mask", { onEvent });
      // Never throws, even though no file could be opened.
      await expect(logger.info("resolve", "still works")).resolves.toBeUndefined();
      await expect(logger.info("write", "still works again")).resolves.toBeUndefined();
      await logger.close();
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
    const seen: LogEntry[] = [];
    const onEvent = (e: LogEntry): void => {
      seen.push(e);
    };

    const chunks = await captureStderr(async () => {
      const logger = await createLogger(asDir, "compose", { onEvent });
      for (let i = 0; i < 3; i++) {
        await expect(logger.warn("retry", `retry ${i}`)).resolves.toBeUndefined();
      }
      await logger.close();
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

  it.skipIf(process.platform === "win32")(
    "never lets a stalled log file hold a verb, even a cancelled one",
    async () => {
      // A named pipe nobody reads: every append to it blocks until a reader opens it.
      const fifo = path.join(tmp, "stalled.log");
      execFileSync("mkfifo", [fifo]);
      const sdk = new GptImg();
      const seen: LogEntry[] = [];
      try {
        const started = Date.now();
        await sdk.backplate({ size: 16, from: "#ffffff", to: "#000000", outDir: tmp, outName: "plate" }, { log: { file: fifo }, onEvent: (e) => seen.push(e) });
        const ctrl = new AbortController();
        ctrl.abort();
        await expect(
          sdk.backplate({ size: 16, from: "#ffffff", to: "#000000", outDir: tmp, outName: "plate-2" }, { log: { file: fifo }, signal: ctrl.signal }),
        ).rejects.toMatchObject({ code: "cancelled" });
        // Each call waits at most the bounded close for its pending lines.
        expect(Date.now() - started).toBeLessThan(6_000);
        expect(seen.length).toBeGreaterThan(0);
      } finally {
        // Release the blocked writes so no thread stays parked on the pipe.
        const reader = createReadStream(fifo);
        reader.on("data", () => undefined);
        await new Promise((resolve) => setTimeout(resolve, 100));
        reader.destroy();
      }
    },
    10_000,
  );
});
