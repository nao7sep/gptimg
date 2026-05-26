import { ProfileError } from "../errors.js";
import type { Profile, ResolvedProfile } from "../types.js";
import { deobfuscate } from "./obfuscate.js";

/**
 * Resolve the API key from the profile.
 *
 * Order:
 *   1. `apiKeyEnv` field names an env var that is set and non-empty → env value.
 *   2. `apiKey` field is present → decode if marked, use as-is otherwise.
 *   3. Throw `ProfileError("apiKey.missing")`.
 *
 * Env wins because the env variable requires deliberate per-session action;
 * the persistent profile is the baseline, the env var is the runtime override.
 * If `apiKeyEnv` names a variable that isn't set, fall through to `apiKey`.
 */
export function resolveProfile(profile: Profile): ResolvedProfile {
  const { apiKey: storedKey, apiKeyEnv, ...rest } = profile;

  if (typeof apiKeyEnv === "string" && apiKeyEnv.length > 0) {
    const envValue = process.env[apiKeyEnv];
    if (typeof envValue === "string" && envValue.length > 0) {
      return {
        redacted: rest as Omit<Profile, "apiKey" | "apiKeyEnv">,
        apiKey: envValue,
        apiKeySource: `env:${apiKeyEnv}`,
      };
    }
  }

  if (typeof storedKey === "string" && storedKey.length > 0) {
    return {
      redacted: rest as Omit<Profile, "apiKey" | "apiKeyEnv">,
      apiKey: deobfuscate(storedKey),
      apiKeySource: "profile.apiKey",
    };
  }

  throw new ProfileError(
    "apiKey.missing",
    "No apiKey resolved from profile or environment",
  );
}
