import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { ProfileError } from "../errors.js";
import type { Profile } from "../types.js";
import { ProfileSchema, formatProfileZodError } from "./schema.js";

// POSIX-only. Windows reports a synthesized mode whose lower bits do not
// reflect access control, so this check would produce false positives there.
const ENFORCE_FILE_MODE = process.platform !== "win32";

/**
 * Options for `loadProfile`.
 *
 * `enforceMode` (default true): on POSIX, refuse to return a profile that
 * carries an `apiKey` when the file is readable beyond the owner. Set false
 * from callers whose purpose is to *modify* the profile (e.g. `clearApiKey`,
 * `setApiKey`) — those callers immediately rewrite the file at 0o600, so the
 * insecure state is being repaired rather than ignored. When false, the
 * file's mode is not fetched at all; there is no failure surface from a
 * stat-only error on the modify paths.
 */
export interface LoadProfileOptions {
  enforceMode?: boolean;
}

interface RawProfileRead {
  text: string;
  /** Mode of the opened inode (POSIX-only, gated by enforceMode). 0 when unread. */
  mode: number;
}

/**
 * Open the profile once and pull content (and optionally the mode) off the
 * same file handle. `fstat` on an open descriptor reports the inode the read
 * is reading from, so there is no path-level TOCTOU between fetching the
 * mode and fetching the bytes. The two failure spaces are also separated:
 *
 *   - `open()` failure is the existence question. ENOENT here means the
 *     profile does not exist; anything else is an open-time read failure.
 *   - Any failure *after* `open()` succeeds is a read failure on a file we
 *     proved exists. It is never misreported as "not found".
 */
async function readProfileFile(
  filePath: string,
  fetchMode: boolean,
): Promise<RawProfileRead> {
  let fh: FileHandle;
  try {
    fh = await open(filePath, "r");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new ProfileError(
        "profile.notFound",
        `Profile not found at ${filePath}`,
        { cause: err },
      );
    }
    throw new ProfileError(
      "profile.readFailed",
      `Failed to open profile at ${filePath}: ${e.message}`,
      { cause: err },
    );
  }
  try {
    let mode = 0;
    if (fetchMode) {
      mode = (await fh.stat()).mode;
    }
    const text = await fh.readFile("utf-8");
    return { text, mode };
  } catch (err) {
    throw new ProfileError(
      "profile.readFailed",
      `Failed to read profile at ${filePath}: ${(err as Error).message}`,
      { cause: err },
    );
  } finally {
    await fh.close().catch(() => {});
  }
}

function parseProfile(text: string, filePath: string): Profile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ProfileError(
      "profile.invalidJson",
      `Invalid JSON in profile at ${filePath}`,
      { cause: err },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProfileError(
      "profile.invalidJson",
      `Profile at ${filePath} must be a JSON object`,
    );
  }
  const result = ProfileSchema.safeParse(parsed);
  if (!result.success) {
    throw new ProfileError(
      "profile.validationFailed",
      `Profile at ${filePath} invalid: ${formatProfileZodError(result.error)}`,
    );
  }
  return result.data as Profile;
}

function assertSecureMode(filePath: string, mode: number, profile: Profile): void {
  if (!ENFORCE_FILE_MODE) return;
  if (typeof profile.apiKey !== "string" || profile.apiKey.length === 0) return;
  if ((mode & 0o077) === 0) return;
  const octal = (mode & 0o777).toString(8).padStart(3, "0");
  throw new ProfileError(
    "profile.insecureMode",
    `Profile at ${filePath} contains apiKey but file mode is ${octal} (readable beyond owner). ` +
      `Run \`chmod 600 ${filePath}\` to restrict it, or remove apiKey and use apiKeyEnv instead.`,
  );
}

export async function loadProfile(
  filePath: string,
  opts: LoadProfileOptions = {},
): Promise<Profile> {
  const enforceMode = opts.enforceMode ?? true;
  const { text, mode } = await readProfileFile(
    filePath,
    enforceMode && ENFORCE_FILE_MODE,
  );
  const profile = parseProfile(text, filePath);
  if (enforceMode) assertSecureMode(filePath, mode, profile);
  return profile;
}
