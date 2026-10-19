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

/**
 * The default output stem of generate, edit and vision:
 * `yyyymmdd-hhmmss-utc-<id>-gptimg`. Concurrent calls without an `outName`
 * are expected (a script fanning out prompts, a vision check beside a
 * generate), so the stem carries a short random ID beside the second stamp.
 */
export function defaultStem(ts: string = utcTimestamp(), id: string = fileNameId()): string {
  return `${ts}-${id}-gptimg`;
}
