import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendLog,
  closeLog,
  createLogger,
  openLog,
  safeLogError,
  type Logger,
} from "../../src/log/index.js";

describe("log helpers", () => {
  let tmp: string;
  let file: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-log-"));
    file = path.join(tmp, "nested", "test.jsonl");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("opens, appends redacted JSONL entries, and closes", async () => {
    const handle = await openLog(file, "generate");
    await appendLog(handle, {
      ts: "2026-01-01T00:00:00.000Z",
      level: "info",
      stage: "request",
      msg: "hello",
      data: { apiKey: "secret", value: 1 },
    });
    await closeLog(handle);

    const lines = (await readFile(file, "utf-8")).trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      ts: "2026-01-01T00:00:00.000Z",
      verb: "generate",
      level: "info",
      stage: "request",
      msg: "hello",
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

  it("safeLogError preserves the original path when logging fails", async () => {
    const logger: Pick<Logger, "error"> = {
      error: vi.fn().mockRejectedValue(new Error("disk full")),
    };

    await expect(safeLogError(logger, "original")).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith("error", "original", undefined);
  });
});
