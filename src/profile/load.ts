import { readFile, stat } from "node:fs/promises";
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
 * insecure state is being repaired rather than ignored.
 */
export interface LoadProfileOptions {
  enforceMode?: boolean;
}

export async function loadProfile(
  filePath: string,
  opts: LoadProfileOptions = {},
): Promise<Profile> {
  const enforceMode = opts.enforceMode ?? true;
  let text: string;
  let mode = 0;
  try {
    text = await readFile(filePath, "utf-8");
    if (ENFORCE_FILE_MODE) {
      const st = await stat(filePath);
      mode = st.mode;
    }
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
      `Failed to read profile at ${filePath}: ${e.message}`,
      { cause: err },
    );
  }
  let profile: Profile;
  try {
    const parsed = JSON.parse(text);
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
    profile = result.data as Profile;
  } catch (err) {
    if (err instanceof ProfileError) throw err;
    throw new ProfileError(
      "profile.invalidJson",
      `Invalid JSON in profile at ${filePath}`,
      { cause: err },
    );
  }
  if (
    enforceMode &&
    ENFORCE_FILE_MODE &&
    typeof profile.apiKey === "string" &&
    profile.apiKey.length > 0 &&
    (mode & 0o077) !== 0
  ) {
    const octal = (mode & 0o777).toString(8).padStart(3, "0");
    throw new ProfileError(
      "profile.insecureMode",
      `Profile at ${filePath} contains apiKey but file mode is ${octal} (readable beyond owner). ` +
        `Run \`chmod 600 ${filePath}\` to restrict it, or remove apiKey and use apiKeyEnv instead.`,
    );
  }
  return profile;
}
