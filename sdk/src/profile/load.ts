import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { GptImgError, fsError } from "../errors.ts";
import { PROFILE_FORMAT_VERSION } from "../format-versions.ts";
import { takeFormatVersion } from "../internal/format-version.ts";
import { assertAbsolutePath } from "../internal/absolute-path.ts";
import { firstZodIssue, formatZodError } from "../internal/zodError.ts";
import type { LoadedProfile, Policy, Profile } from "../types.ts";
import { deobfuscate } from "./obfuscate.ts";
import { validatePolicy } from "../policy/schemas.ts";
import { ProfileSchema } from "./schema.ts";

/** The environment a caller passes in; the SDK never reads the process environment. */
export type EnvironmentMap = Readonly<Record<string, string | undefined>>;

export interface LoadProfileOptions {
  /**
   * The variables a profile's `apiKeyEnv` and path references resolve from,
   * typically `process.env`. Omitted, nothing resolves from the environment.
   */
  env?: EnvironmentMap;
}

// POSIX-only. Windows reports a synthesized mode whose lower bits do not
// reflect access control, so this check would produce false positives there.
function enforcesFileMode(): boolean {
  return process.platform !== "win32";
}

/**
 * Check a parsed profile body against format 2 (format 1 is a subset), for an
 * app that creates or edits profiles with the SDK's own rules. The value is the
 * file's JSON with or without its `formatVersion`.
 */
export function validateProfile(value: unknown, subject = "profile"): Profile {
  const { version, body } = takeFormatVersion(value, PROFILE_FORMAT_VERSION, "profile", subject);
  const result = ProfileSchema.safeParse(version >= 2 ? body : withoutEmptyOptionals(body));
  if (!result.success) {
    const { field, constraint } = firstZodIssue(result.error);
    throw new GptImgError("profile.malformed", `${subject} is invalid: ${formatZodError(result.error)}`, {
      subject,
      details: { field, constraint },
    });
  }
  // The policy is checked whole here, so a misspelt section fails at load, not when a verb reads it.
  if (result.data.policy !== undefined) validatePolicy(result.data.policy);
  return result.data as Profile;
}

/**
 * Format 1 and unmarked v0.1.0 profiles accepted an empty `apiKeyEnv`,
 * `organization` or `project` and treated it as absent, so they read that way.
 */
function withoutEmptyOptionals(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...body };
  for (const field of ["apiKeyEnv", "organization", "project"]) if (out[field] === "") delete out[field];
  return out;
}

/**
 * Read a profile from the absolute `filePath` the caller gives and return it
 * with its key resolved and its paths absolute. The SDK never searches for a
 * profile and never writes one.
 *
 * Key resolution: the variable `apiKeyEnv` names, looked up in `env`, then the
 * stored `apiKey` (`obf:` or plain), each trimmed, empty meaning absent. A
 * missing key is not an error here: local verbs need none, and a paid verb
 * fails `apiKey.missing` when it runs. A profile that stores a key and is
 * readable beyond its owner on POSIX is refused, never tightened: a library does
 * not change the mode of a path its caller handed it.
 */
export async function loadProfile(filePath: string, options: LoadProfileOptions = {}): Promise<LoadedProfile> {
  assertAbsolutePath(filePath, "profile path");
  const env = options.env ?? {};
  const { text, mode } = await readProfileFile(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new GptImgError("profile.malformed", `Invalid JSON in profile at ${filePath}`, {
      cause: err,
      subject: filePath,
    });
  }
  const profile = validateProfile(parsed, filePath);
  assertSecureMode(filePath, mode, profile);

  const base = path.dirname(filePath);
  const key = resolveKey(profile, env);
  return {
    path: filePath,
    provider: "openai",
    apiKey: key?.apiKey ?? null,
    apiKeySource: key?.source ?? null,
    ...(profile.organization !== undefined && { organization: profile.organization }),
    ...(profile.project !== undefined && { project: profile.project }),
    ...(profile.modelsDir !== undefined && { modelsDir: resolveProfilePath(profile.modelsDir, "modelsDir", base, env, filePath) }),
    ...(profile.logDir !== undefined && { logDir: resolveProfilePath(profile.logDir, "logDir", base, env, filePath) }),
    ...(profile.policy !== undefined && { policy: profile.policy as Policy }),
  };
}

function resolveKey(profile: Profile, env: EnvironmentMap): { apiKey: string; source: string } | null {
  if (profile.apiKeyEnv) {
    const value = env[profile.apiKeyEnv]?.trim();
    if (value) return { apiKey: value, source: `env:${profile.apiKeyEnv}` };
  }
  if (typeof profile.apiKey === "string" && profile.apiKey.length > 0) {
    const value = deobfuscate(profile.apiKey).trim();
    if (value) return { apiKey: value, source: "profile.apiKey" };
  }
  return null;
}

/**
 * A profile path as an absolute path: `~` from the map's `HOME` (`USERPROFILE`
 * on Windows), `$VAR`, `${VAR}` and `%VAR%` from the map, and a relative result
 * against the profile's own folder, never the working directory. A reference
 * the map cannot satisfy is `profile.malformed` naming the variable.
 */
function resolveProfilePath(value: string, field: string, base: string, env: EnvironmentMap, subject: string): string {
  const lookup = (name: string): string => {
    const v = env[name];
    if (v === undefined || v.length === 0) {
      throw new GptImgError(
        "profile.malformed",
        `Profile ${field} ${JSON.stringify(value)} refers to ${name}, which the environment passed to loadProfile does not set.`,
        { subject, details: { field, variable: name } },
      );
    }
    return v;
  };
  let out = value;
  if (out === "~" || out.startsWith("~/") || out.startsWith("~\\")) {
    const home = lookup(process.platform === "win32" ? "USERPROFILE" : "HOME");
    out = out === "~" ? home : path.join(home, out.slice(2));
  }
  out = out
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => lookup(name))
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => lookup(name))
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_m, name: string) => lookup(name));
  return path.isAbsolute(out) ? path.normalize(out) : path.resolve(base, out);
}

interface RawProfileRead {
  text: string;
  /** Mode of the opened inode; 0 where the mode is not checked. */
  mode: number;
}

/**
 * Open the profile once and read content and mode off the same handle, so the
 * mode checked is the mode of the bytes read (a symlink's target).
 */
async function readProfileFile(filePath: string): Promise<RawProfileRead> {
  let fh: FileHandle;
  try {
    fh = await open(filePath, "r");
  } catch (err) {
    throw fsError(err, "Failed to open profile", filePath);
  }
  try {
    const mode = enforcesFileMode() ? (await fh.stat()).mode : 0;
    return { text: await fh.readFile("utf-8"), mode };
  } catch (err) {
    throw fsError(err, "Failed to read profile", filePath);
  } finally {
    await fh.close().catch(() => {});
  }
}

function assertSecureMode(filePath: string, mode: number, profile: Profile): void {
  if (!enforcesFileMode()) return;
  if (typeof profile.apiKey !== "string" || profile.apiKey.length === 0) return;
  if ((mode & 0o077) === 0) return;
  const octal = (mode & 0o777).toString(8).padStart(3, "0");
  throw new GptImgError(
    "profile.insecureMode",
    `Profile at ${filePath} contains apiKey but its mode is ${octal} (readable beyond its owner). ` +
      `Run \`chmod 600 ${filePath}\`, or remove apiKey and name the variable in apiKeyEnv instead.`,
    { subject: filePath, details: { mode: octal } },
  );
}
