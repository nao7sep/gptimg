import { chmodSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { customAlphabet } from "nanoid";
import { ProfileError } from "../errors.js";

/**
 * Expand a path setting (`GPTIMG_DATA_DIR`, `GPTIMG_MODELS_DIR`, the
 * `profileDir`/`logDir` options), per the storage-path-conventions. An unset
 * reference expands to the empty string, as in a shell.
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
 * GptImg's storage root, per the storage-path-conventions.
 *
 * The `profileDir`/`logDir` constructor options (see `resolveDirOption`) and
 * `GPTIMG_MODELS_DIR` layer above it: a caller that injects a directory
 * bypasses the root for that subpath.
 */
export function defaultProfileDir(): string {
  const home = homedir();
  const override = process.env.GPTIMG_DATA_DIR;
  if (override !== undefined && override.length > 0) {
    const expanded = expandHomeAndEnv(override, home);
    if (expanded.length === 0) {
      throw new ProfileError(
        "profile.invalidHome",
        `GPTIMG_DATA_DIR is set but expands to an empty path: ${JSON.stringify(override)}. ` +
          `Unset it to use the default ~/.gptimg, or set it to a usable directory.`,
      );
    }
    return path.isAbsolute(expanded) ? expanded : path.resolve(home, expanded);
  }
  return path.join(home, ".gptimg");
}

/**
 * A `profileDir` or `logDir` constructor option as an absolute directory: `~`
 * and environment references expanded, and a relative value resolved against
 * the home directory, never the working directory (storage-path-conventions).
 */
export function resolveDirOption(value: string, option: "profileDir" | "logDir"): string {
  const home = homedir();
  const expanded = expandHomeAndEnv(value, home);
  if (expanded.length === 0) {
    throw new ProfileError(
      "profile.invalidHome",
      `The ${option} option expands to an empty path: ${JSON.stringify(value)}.`,
    );
  }
  return path.isAbsolute(expanded) ? expanded : path.resolve(home, expanded);
}

/**
 * Create the profile root and secure it, per the storage-path-conventions.
 * Only the root itself is touched, never its contents. `GptImg`'s constructor
 * calls it once per instance before anything is written under `profileDir`.
 *
 * A failure to tighten an existing root is swallowed so it never stops the
 * caller (sdk-toolkit-conventions, *Output*).
 */
export function ensureSecureProfileRoot(profileDir: string): void {
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  try {
    const mode = statSync(profileDir).mode & 0o777;
    if (mode !== 0o700) {
      chmodSync(profileDir, 0o700);
    }
  } catch {
    // Best-effort hardening only; the app proceeds either way.
  }
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
  const override = process.env.GPTIMG_MODELS_DIR;
  if (override !== undefined && override.length > 0) {
    const home = homedir();
    const expanded = expandHomeAndEnv(override, home);
    if (expanded.length === 0) {
      throw new ProfileError(
        "profile.invalidModelsDir",
        `GPTIMG_MODELS_DIR is set but expands to an empty path: ${JSON.stringify(override)}.`,
      );
    }
    return path.isAbsolute(expanded) ? expanded : path.resolve(home, expanded);
  }
  return path.join(profileDir, "models");
}

/**
 * The default log file of one verb call: `yyyymmdd-hhmmss-fff-utc-<discriminator>.log`,
 * stamped with `utcTimestampMs`. A caller's `log` option overrides it. It departs from the
 * logging-conventions' bare-timestamp name deliberately: an SDK starts a session per call, and
 * calls fanned out in one millisecond would otherwise share a file, so the name carries the
 * same short discriminator as `defaultStem`.
 */
export function defaultLogPath(logDir: string, ts: string, discriminator: string = nameDiscriminator()): string {
  return path.join(logDir, `${ts}-${discriminator}.log`);
}

/** `yyyymmdd-hhmmss` in UTC — the date-time body of the filename stamp. */
function utcBody(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  );
}

/**
 * `yyyymmdd-hhmmss-fff-utc`, the machine-paced filename stamp of the
 * timestamp-conventions. It names the session log and starts the default
 * output stem (`defaultStem`).
 */
export function utcTimestampMs(now: Date = new Date()): string {
  const ms = String(now.getUTCMilliseconds()).padStart(3, "0");
  return `${utcBody(now)}-${ms}-utc`;
}

// Lowercase letters and digits, per the timestamp-conventions' filename form.
// Six characters give about 2.2 billion values per millisecond.
const nameDiscriminator = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 6);

/**
 * The default output stem of generate, edit and vision:
 * `yyyymmdd-hhmmss-fff-utc-<discriminator>-gptimg`. Concurrent calls without
 * an `outName` are expected (a script fanning out prompts, a vision check
 * beside a generate), so the stem carries the millisecond stamp plus a short
 * random discriminator and two calls cannot reserve the same stem.
 */
export function defaultStem(ts: string = utcTimestampMs(), discriminator: string = nameDiscriminator()): string {
  return `${ts}-${discriminator}-gptimg`;
}
