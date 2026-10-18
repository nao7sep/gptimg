import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { customAlphabet } from "nanoid";

// Lowercase letters and digits, per the timestamp-conventions' filename form.
// Six characters give about 2.2 billion values per second.
const fileNameId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 6);

/** `yyyymmdd-hhmmss-utc`, the second-precision filename stamp of the timestamp-conventions. */
export function utcTimestamp(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}-utc`
  );
}

// A session log file in a caller-given folder: `yyyymmdd-hhmmss-utc-<id>.log`.
// Calls into the SDK run concurrently and may share one log folder, so the stamp
// carries an ID (logging-conventions).
export function logPathIn(logDir: string, ts: string, id: string): string {
  return path.join(logDir, `${ts}-${id}.log`);
}

// Claims this call's log in a caller-given folder by creating it exclusively and
// owner-only (it records prompts and provider responses), drawing a new ID in
// the unlikely event the name already exists, so every call keeps its own file.
// A failure other than "already exists" returns the name unclaimed: logging
// never fails the verb, and the logger reports the same failure on its first line.
export async function claimLogPath(logDir: string, now: Date = new Date()): Promise<string> {
  await mkdir(logDir, { recursive: true }).catch(() => undefined);
  const ts = utcTimestamp(now);
  for (;;) {
    const candidate = logPathIn(logDir, ts, fileNameId());
    try {
      await (await open(candidate, "wx", 0o600)).close();
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return candidate;
    }
  }
}

/**
 * The default output stem of generate, edit and vision:
 * `yyyymmdd-hhmmss-utc-<id>-gptimg`. Concurrent calls without an `outName`
 * are expected (a script fanning out prompts, a vision check beside a
 * generate), so the stem carries a short random ID beside the second stamp.
 */
export function defaultStem(ts: string = utcTimestamp(), id: string = fileNameId()): string {
  return `${ts}-${id}-gptimg`;
}
