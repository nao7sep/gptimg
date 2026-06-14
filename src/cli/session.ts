/**
 * CLI process-session log — the one-file-per-process-launch record the logging
 * conventions require: startup (version + invocation), shutdown (clean vs. forced),
 * and global last-resort crash hooks (uncaughtException / unhandledRejection) that
 * flush before the process dies.
 *
 * This lives in the CLI layer ONLY. A library must never install global `process`
 * handlers — doing so would hijack a host app that embeds the SDK — so the SDK does
 * not; the CLI, which owns the process, does. It is also distinct from the per-verb
 * operation logs the SDK writes (those capture one verb's resolve/request/write);
 * this captures the process lifecycle around them.
 *
 * Writes are synchronous (appendFileSync): a crash or `exit` handler cannot await,
 * and the convention requires the last lines before death to reach disk. Lines use
 * the documented envelope (`time`/`level`/`message` + free fields) without a
 * `verb`/`stage` — those belong to verb-operation logs, and a lifecycle line is not
 * a verb operation.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { redact } from "../profile/redact.js";
import {
  DEFAULT_PROFILE_DIR,
  defaultLogDir,
  defaultLogPath,
  utcTimestampMs,
} from "../internal/paths.js";
import type { LogLevel } from "../types.js";
import { CLI_VERSION } from "./version.js";

let sessionPath: string | null = null;
let shutdownLogged = false;

/** One envelope-compliant JSON Lines record, written synchronously. Never throws. */
function writeLine(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  const p = sessionPath;
  if (p === null) return;
  const line: { time: string; level: LogLevel; message: string; data?: Record<string, unknown> } = {
    time: new Date().toISOString(),
    level,
    message,
  };
  if (data) line.data = redact(data);
  try {
    appendFileSync(p, JSON.stringify(line) + "\n", "utf-8");
  } catch (err) {
    // Logging must never crash the process; degrade to stderr, best effort.
    try {
      process.stderr.write(
        JSON.stringify({
          time: new Date().toISOString(),
          level: "warn",
          message: "session log unavailable",
          data: { path: p, error: err instanceof Error ? err.message : String(err) },
        }) + "\n",
      );
    } catch {
      // give up — never throw from the logging path
    }
  }
}

/** Full error fidelity per the logging convention: type, message, stack, and cause. */
function describeError(value: unknown): Record<string, unknown> {
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      errorType: value.name,
      message: value.message,
      stack: value.stack,
    };
    if (value.cause !== undefined) {
      out.cause = value.cause instanceof Error ? value.cause.message : String(value.cause);
    }
    return out;
  }
  return { message: String(value) };
}

/**
 * Open the process-session log and install lifecycle + crash hooks. Call once,
 * from the CLI entry point, before parsing. The log path is set up here; the file
 * is created lazily on the first write.
 */
export function startCliSession(argv: string[]): void {
  if (sessionPath !== null) return;
  const dir = defaultLogDir(DEFAULT_PROFILE_DIR);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // appendFileSync surfaces any write failure to stderr; don't crash on setup.
  }
  sessionPath = defaultLogPath(dir, utcTimestampMs());

  writeLine("info", "cli startup", { version: CLI_VERSION, args: argv.slice(2) });

  process.on("exit", (code) => {
    if (shutdownLogged) return;
    shutdownLogged = true;
    const reason = code === 0 ? "clean" : code === 130 ? "forced (SIGINT)" : "error";
    writeLine(code === 0 ? "info" : code === 130 ? "warn" : "error", "cli shutdown", {
      exitCode: code,
      reason,
    });
  });

  process.on("uncaughtException", (err) => {
    writeLine("error", "uncaught exception", describeError(err));
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    writeLine("error", "unhandled rejection", describeError(reason));
    process.exit(1);
  });
}
