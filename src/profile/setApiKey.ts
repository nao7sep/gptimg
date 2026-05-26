import { mkdir } from "node:fs/promises";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { ProfileError } from "../errors.js";
import type { Profile } from "../types.js";
import { loadProfile } from "./load.js";
import { obfuscate } from "./obfuscate.js";

async function ensureDir(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}

async function writeProfile(filePath: string, profile: Profile): Promise<void> {
  await ensureDir(filePath);
  const text = JSON.stringify(profile, null, 2) + "\n";
  await writeFileAtomic(filePath, text, { encoding: "utf-8" });
}

/**
 * Write `apiKey` to the profile, storing it in obfuscated form
 * (`"obf:" + base64(reverse(raw))`). Preserves every other field. Atomic.
 * If the profile file does not exist, a minimal `{ provider: "openai" }`
 * profile is created.
 */
export async function setApiKey(filePath: string, rawKey: string): Promise<void> {
  let profile: Profile;
  try {
    profile = await loadProfile(filePath);
  } catch (err) {
    if (err instanceof ProfileError && err.code === "profile.notFound") {
      profile = { provider: "openai" };
    } else {
      throw err;
    }
  }
  profile.apiKey = obfuscate(rawKey);
  await writeProfile(filePath, profile);
}

/**
 * Remove `apiKey` from the profile. Preserves every other field including
 * `apiKeyEnv`. Atomic. No-op if the profile or the field doesn't exist.
 */
export async function clearApiKey(filePath: string): Promise<void> {
  let profile: Profile;
  try {
    profile = await loadProfile(filePath);
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
