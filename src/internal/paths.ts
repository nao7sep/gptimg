import { homedir } from "node:os";
import path from "node:path";
import { ProfileError } from "../errors.js";

/**
 * Expand a configured path string before it is made absolute: a leading `~`
 * (or `~/`) becomes the home directory, and `$VAR` / `${VAR}` / `%VAR%`
 * references are substituted from the environment (an unset reference expands
 * to the empty string, matching shell behavior). This runs on values that come
 * from the environment (`GPTIMG_HOME`), never on internal literals, per the
 * storage-path convention's "expand before use" rule.
 */
function expandHomeAndEnv(value: string, home: string): string {
  let out = value;
  if (out === "~") {
    out = home;
  } else if (out.startsWith("~/") || out.startsWith("~\\")) {
    out = path.join(home, out.slice(2));
  }
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => process.env[name] ?? "");
  out = out.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => process.env[name] ?? "");
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_m, name: string) => process.env[name] ?? "");
  return out;
}

/**
 * The single storage root for GptImg, per the storage-path convention.
 *
 * Resolution order:
 *   1. `GPTIMG_HOME`, if set and non-empty — the relocation override. Its value
 *      is expanded (leading `~`, `$VAR`/`%VAR%`) and then made absolute. A
 *      relative value is resolved against the home directory, NEVER against
 *      `process.cwd()`, so the override can never reintroduce a cwd dependence.
 *      A value that expands to empty is unusable and is a startup error rather
 *      than a silent fallback to the default.
 *   2. Otherwise the default `~/.gptimg`.
 *
 * Resolved lazily (a function, not a module-level constant) so a process that
 * sets `GPTIMG_HOME` late — and a test that relocates the root through the
 * documented env-var seam rather than a private setter — is honored, and so the
 * root is never frozen from a half-set environment at import time.
 *
 * The finer per-subpath overrides (`profileDir`/`logDir` constructor options,
 * `GPTIMG_MODELS_DIR`) layer ABOVE this: a caller that injects an explicit
 * directory bypasses the root entirely for that subpath.
 */
export function defaultProfileDir(): string {
  const home = homedir();
  const override = process.env.GPTIMG_HOME;
  if (override !== undefined && override.length > 0) {
    const expanded = expandHomeAndEnv(override, home);
    if (expanded.length === 0) {
      throw new ProfileError(
        "profile.invalidHome",
        `GPTIMG_HOME is set but expands to an empty path: ${JSON.stringify(override)}. ` +
          `Unset it to use the default ~/.gptimg, or set it to a usable directory.`,
      );
    }
    // Absolutize against HOME, never the working directory.
    return path.isAbsolute(expanded) ? expanded : path.resolve(home, expanded);
  }
  return path.join(home, ".gptimg");
}

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
// (a `.log` file holding JSON Lines is the convention). A caller's `log` option
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
 * tool designed to run concurrently. GptImg is exactly that case: it names the
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
