import { execFileSync } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LogEntry } from "../src/index.js";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface ValidationContext {
  repoRoot: string;
  resultDir: string;
  logPath: string;
  onProgress: (entry: LogEntry) => void;
}

interface ValidationSpec {
  task: string;
  version: string;
  execute: (context: ValidationContext) => Promise<Record<string, unknown>>;
}

interface ValidationReport {
  schemaVersion: 1;
  task: string;
  status: "running" | "passed" | "failed" | "interrupted";
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  durationMs?: number;
  candidate: {
    version: string;
    commit: string | null;
    worktreeDirty: boolean | null;
  };
  host: {
    platform: NodeJS.Platform;
    architecture: string;
    osRelease: string;
    nodeVersion: string;
    cpu: string | null;
    logicalCpuCount: number;
    totalMemoryBytes: number;
  };
  processId: number;
  resultFile: string;
  logFile: string;
  latestProgress?: LogEntry;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

function gitOutput(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function serializeError(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { type: typeof error, message: String(error) };
  const value: Record<string, unknown> = {
    type: error.constructor?.name || error.name || "Error",
    message: error.message,
  };
  const code = (error as Error & { code?: unknown }).code;
  if (code !== undefined) value.code = code;
  if (error.stack) value.stack = error.stack;
  if (error.cause !== undefined && depth < 4) {
    value.cause = serializeError(error.cause, depth + 1);
  }
  return value;
}

function writeReport(reportPath: string, report: ValidationReport): void {
  const temporaryPath = `${reportPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, reportPath);
}

export async function runWindowsHeavyValidation(spec: ValidationSpec): Promise<void> {
  const resultDir = path.join(REPO_ROOT, "validation-results", "windows", spec.task);
  const resultFile = path.join(resultDir, "result.json");
  const logFile = path.join(resultDir, "gptimg.jsonl");
  await mkdir(resultDir, { recursive: true });

  const cpus = os.cpus();
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const status = gitOutput(["status", "--porcelain"]);
  const report: ValidationReport = {
    schemaVersion: 1,
    task: spec.task,
    status: "running",
    startedAt,
    updatedAt: startedAt,
    candidate: {
      version: spec.version,
      commit: gitOutput(["rev-parse", "HEAD"]),
      worktreeDirty: status === null ? null : status.length > 0,
    },
    host: {
      platform: process.platform,
      architecture: process.arch,
      osRelease: os.release(),
      nodeVersion: process.version,
      cpu: cpus[0]?.model ?? null,
      logicalCpuCount: cpus.length,
      totalMemoryBytes: os.totalmem(),
    },
    processId: process.pid,
    resultFile,
    logFile,
  };

  const save = (): void => {
    report.updatedAt = new Date().toISOString();
    writeReport(resultFile, report);
  };

  let terminal = false;
  const interrupt = (signal: "SIGINT" | "SIGTERM"): void => {
    if (terminal) return;
    terminal = true;
    const finished = Date.now();
    report.status = "interrupted";
    report.finishedAt = new Date(finished).toISOString();
    report.durationMs = finished - started;
    report.error = { type: "Signal", message: `Validation interrupted by ${signal}.` };
    save();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const onSigint = (): void => interrupt("SIGINT");
  const onSigterm = (): void => interrupt("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  const onProgress = (entry: LogEntry): void => {
    report.latestProgress = entry;
    save();
    console.log(`[${entry.time}] ${entry.stage}: ${entry.message}`);
  };

  save();
  console.log(`Result: ${resultFile}`);
  console.log(`Log:    ${logFile}`);

  try {
    await writeFile(logFile, "", "utf8");
    if (process.platform !== "win32") {
      throw new Error("This validation runner must be executed on Windows.");
    }
    process.env.GPTIMG_DEBUG = "1";
    report.result = await spec.execute({
      repoRoot: REPO_ROOT,
      resultDir,
      logPath: logFile,
      onProgress,
    });
    const finished = Date.now();
    report.status = "passed";
    report.finishedAt = new Date(finished).toISOString();
    report.durationMs = finished - started;
    terminal = true;
    save();
    console.log(`PASS after ${report.durationMs} ms`);
  } catch (error) {
    const finished = Date.now();
    report.status = "failed";
    report.finishedAt = new Date(finished).toISOString();
    report.durationMs = finished - started;
    report.error = serializeError(error);
    terminal = true;
    save();
    console.error(`FAIL after ${report.durationMs} ms: ${report.error.message}`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}
