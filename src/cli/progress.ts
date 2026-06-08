import type { LogEntry } from "../types.js";
import type { VerbCallOptions } from "../verbs/options.js";
import { getAbortSignal } from "./abort.js";

let quiet = false;

/** Toggle progress rendering. Set from the global `--quiet` flag before any verb runs. */
export function setQuiet(value: boolean): void {
  quiet = value;
}

/**
 * Render one progress event as a single line of JSONL on stderr — the whole
 * typed event (ts, level, stage, verb, msg, and any structured `data`), one
 * object per line. stdout stays reserved for the one-shot result document, so
 * progress never touches it. Not gated on whether stderr is a TTY: scripts and
 * agents watch stderr and want every line (§6).
 */
export function renderProgress(entry: LogEntry): void {
  if (quiet) return;
  process.stderr.write(JSON.stringify(entry) + "\n");
}

/**
 * The standard call options every CLI verb passes to the SDK: the shared abort
 * signal plus the progress renderer. This is the one place the CLI binds the
 * SDK's `onProgress` hook to stderr.
 */
export function cliCallOptions(): VerbCallOptions {
  return { signal: getAbortSignal(), onProgress: renderProgress };
}
