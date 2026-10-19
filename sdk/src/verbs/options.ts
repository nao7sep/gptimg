import type { LogEntry, ProgressUpdate } from "../types.ts";

/**
 * Where a call writes its log (JSON Lines, logging-conventions): a named file,
 * or a fresh `yyyymmdd-hhmmss-utc-<id>.log` in a folder. Both paths are
 * absolute. `debug: true` also writes debug-level lines to the file.
 */
export type LogTarget = { file: string; debug?: boolean } | { dir: string; debug?: boolean };

export interface VerbCallOptions {
  /**
   * Stop the call at its next safe boundary with a `cancelled` error whose
   * `effect` says whether anything had already taken effect. Work a provider
   * has already accepted may still be billed; the SDK stops listening and
   * leaves no unfinished output that looks complete.
   */
  signal?: AbortSignal | undefined;

  /**
   * Receive every structured event the SDK also logs (every level), masked,
   * as it happens. The SDK never writes to a stream itself; a throwing or
   * rejecting hook never affects the call.
   */
  onEvent?: ((event: LogEntry) => void) | undefined;

  /**
   * Receive counts of countable work (download and hash bytes, upscale tiles,
   * grid inputs, icon renditions, feather passes), at most every 100 ms plus
   * the final count.
   */
  onProgress?: ((update: ProgressUpdate) => void) | undefined;

  /**
   * Write a log for this call. Without it, the instance's `logDir` is
   * used when set; otherwise no log is written and events reach
   * only `onEvent`. `false` writes none even when a `logDir` is set.
   */
  log?: LogTarget | false | undefined;
}
