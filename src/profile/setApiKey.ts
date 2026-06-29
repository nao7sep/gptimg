import { mkdir } from "node:fs/promises";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { ProfileError } from "../errors.js";
import type { Profile } from "../types.js";
import { loadProfile } from "./load.js";
import { obfuscate } from "./obfuscate.js";

async function ensureDir(filePath: string): Promise<void> {
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
  } catch (err) {
    throw new ProfileError(
      "profile.writeFailed",
      `Failed to create profile directory for ${filePath}: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

async function writeProfile(filePath: string, profile: Profile): Promise<void> {
  await ensureDir(filePath);
  const text = JSON.stringify(profile, null, 2) + "\n";
  try {
    // 0o600: the profile may hold secrets (apiKey today, tokens later) and is
    // owner-only by contract. Setting the mode unconditionally keeps the
    // invariant from drifting if new sensitive fields are added.
    await writeFileAtomic(filePath, text, { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    throw new ProfileError(
      "profile.writeFailed",
      `Failed to write profile at ${filePath}: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

/**
 * Write `apiKey` to the profile, storing it trimmed and in obfuscated form
 * (`"obf:" + base64` of the reversed UTF-8 bytes). Preserves every other field. Atomic.
 * If the profile file does not exist, a minimal `{ provider: "openai" }`
 * profile is created.
 *
 * The key must be non-empty (ignoring surrounding whitespace); storing an empty
 * key would only surface later as a confusing provider failure. This is the
 * SDK's contract — enforced here so every caller behaves the same.
 */
export async function setApiKey(filePath: string, rawKey: string): Promise<void> {
  if (rawKey.trim().length === 0) {
    throw new ProfileError("apiKey.missing", "API key must not be empty.");
  }
  let profile: Profile;
  try {
    // Skip the insecure-mode halt: this write path immediately rewrites the
    // file at 0o600, so an existing loose-mode profile is being repaired.
    profile = await loadProfile(filePath, { enforceMode: false });
  } catch (err) {
    if (err instanceof ProfileError && err.code === "profile.notFound") {
      profile = { provider: "openai" };
    } else {
      throw err;
    }
  }
  profile.apiKey = obfuscate(rawKey.trim());
  await writeProfile(filePath, profile);
}

/**
 * Remove `apiKey` from the profile. Preserves every other field including
 * `apiKeyEnv`. Atomic. No-op if the profile file or the field doesn't exist.
 */
export async function clearApiKey(filePath: string): Promise<void> {
  let profile: Profile;
  try {
    // Skip the insecure-mode halt: removing the apiKey is the remediation
    // for a loose-mode profile that holds one. Forcing the user to chmod
    // first would block the very action that fixes the leak.
    profile = await loadProfile(filePath, { enforceMode: false });
  } catch (err) {
    if (err instanceof ProfileError && err.code === "profile.notFound") {
      return;
    }
    throw err;
  }
  if (!("apiKey" in profile)) return;
  delete profile.apiKey;
  await writeProfile(filePath, profile);
}
