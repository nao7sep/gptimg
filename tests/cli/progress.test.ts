import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GptImg } from "../../src/gptimg.js";
import { runCli } from "../../src/cli/run.js";
import type { LogEntry } from "../../src/types.js";

function captureChunk(chunk: unknown): string {
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf-8");
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf-8");
  return String(chunk);
}

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const o = process.stdout.write;
  const e = process.stderr.write;
  process.stdout.write = ((c: unknown, ...rest: unknown[]) => {
    stdout += captureChunk(c);
    (rest.find((x) => typeof x === "function") as (() => void) | undefined)?.();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown, ...rest: unknown[]) => {
    stderr += captureChunk(c);
    (rest.find((x) => typeof x === "function") as (() => void) | undefined)?.();
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await runCli(["node", "gptimg", ...args]);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
}

describe("progress emission", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-progress-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function backplateArgs(): string[] {
    return [
      "backplate",
      "--from",
      "#000000",
      "--to",
      "#ffffff",
      "--size",
      "64",
      "--out-dir",
      tmp,
      "--out-name",
      "p",
      "--overwrite",
    ];
  }

  it("SDK: onProgress receives stage events and the SDK writes to no stream", async () => {
    const events: LogEntry[] = [];
    const stdoutSpy = vi.fn(() => true);
    const stderrSpy = vi.fn(() => true);
    const o = process.stdout.write;
    const e = process.stderr.write;
    process.stdout.write = stdoutSpy as unknown as typeof process.stdout.write;
    process.stderr.write = stderrSpy as unknown as typeof process.stderr.write;
    try {
      const sdk = new GptImg();
      await sdk.backplate(
        { from: "#000000", to: "#ffffff", size: 64, outDir: tmp, outName: "p", overwrite: true },
        { onProgress: (entry) => events.push(entry) },
      );
    } finally {
      process.stdout.write = o;
      process.stderr.write = e;
    }
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((ev) => ev.verb === "backplate")).toBe(true);
    expect(events.every((ev) => ev.level === "info" || ev.level === "warn")).toBe(true);
    // §4: the SDK reports through the callback, never to a stream.
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("CLI: progress goes to stderr as JSONL, the JSON result to stdout", async () => {
    const result = await run(backplateArgs());
    expect(result.code).toBe(0);
    // §6.4: stderr is JSONL — one structured event object per line.
    const lines = result.stderr.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const events = lines.map((l) => JSON.parse(l) as LogEntry);
    expect(events.every((ev) => ev.verb === "backplate")).toBe(true);
    expect(events.every((ev) => typeof ev.stage === "string" && typeof ev.msg === "string")).toBe(true);
    // stdout is exactly the one-shot JSON result, parseable on its own.
    expect(JSON.parse(result.stdout).size).toBe(64);
  });

  it("CLI: --quiet suppresses progress but keeps the JSON result", async () => {
    const result = await run(["--quiet", ...backplateArgs()]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).size).toBe(64);
  });
});
