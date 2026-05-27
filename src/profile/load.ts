import { readFile } from "node:fs/promises";
import { ProfileError } from "../errors.js";
import type { Profile } from "../types.js";

export async function loadProfile(filePath: string): Promise<Profile> {
  let text: string;
  try {
    text = await readFile(filePath, "utf-8");
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
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ProfileError(
        "profile.invalidJson",
        `Profile at ${filePath} must be a JSON object`,
      );
    }
    if (typeof parsed.provider !== "string" || parsed.provider.length === 0) {
      throw new ProfileError(
        "profile.invalidJson",
        `Profile at ${filePath} is missing required "provider" field`,
      );
    }
    return parsed as Profile;
  } catch (err) {
    if (err instanceof ProfileError) throw err;
    throw new ProfileError(
      "profile.invalidJson",
      `Invalid JSON in profile at ${filePath}`,
      { cause: err },
    );
  }
}
