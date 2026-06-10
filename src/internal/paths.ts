import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_PROFILE_DIR = path.join(homedir(), ".gptimg");

export function defaultProfilePath(profileDir: string): string {
  return path.join(profileDir, "profile.json");
}

export function defaultRecipePath(profileDir: string): string {
  return path.join(profileDir, "recipe.json");
}

export function defaultLogDir(profileDir: string): string {
  return path.join(profileDir, "logs");
}

export function defaultOutDir(profileDir: string): string {
  return path.join(profileDir, "output");
}

/**
 * Where lazily fetched model files live. Default `<profileDir>/models`.
 * Override with `GPTIMG_MODELS_DIR`.
 */
export function defaultModelsDir(profileDir: string): string {
  const env = process.env.GPTIMG_MODELS_DIR;
  if (env && env.length > 0) return env;
  return path.join(profileDir, "models");
}

// The default per-session log lives in the app's own logs dir and follows the
// logging convention's filename form — here `yyyymmdd-hhmmss-fff-utc.log`. The
// default caller stamps it with `utcTimestampMs` (below): the millisecond-precision
// `-fff` variant the timestamp conventions reserve for concurrent-by-design tools,
// so two runs starting in the same UTC second get distinct log files instead of
// interleaving into one. No app name (the path already implies it) and no `.jsonl`
// (a `.log` file holding JSON Lines is the convention). A user `--log <path>`
// overrides this and is named by the caller.
export function defaultLogPath(logDir: string, ts: string): string {
  return path.join(logDir, `${ts}.log`);
}

/** `yyyymmdd-hhmmss` in UTC — the shared date-time body both filename stamps build on. */
function utcBody(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  );
}

/** Returns `yyyymmdd-hhmmss-utc` per playbook. OS clock via Date. */
export function utcTimestamp(now: Date = new Date()): string {
  return `${utcBody(now)}-utc`;
}

/**
 * Returns `yyyymmdd-hhmmss-fff-utc` — second precision plus a millisecond part.
 * This is the `-fff` exception in the timestamp conventions, permitted for a
 * tool designed to run concurrently. gptimg is exactly that case: it names the
 * per-session log file with this so two runs that start in the same UTC second
 * get distinct log files instead of interleaving into one. OS clock via Date.
 *
 * Both stamps build on the same `utcBody`, so they cannot drift in their shared
 * date-time portion; the millisecond variant just carries one extra segment.
 */
export function utcTimestampMs(now: Date = new Date()): string {
  const ms = String(now.getUTCMilliseconds()).padStart(3, "0");
  return `${utcBody(now)}-${ms}-utc`;
}

export function defaultStem(ts: string): string {
  return `${ts}-gptimg`;
}
