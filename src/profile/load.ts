import { readFile } from "node:fs/promises";
import { ProfileError } from "../errors.js";
import type { Profile } from "../types.js";

function assertBaseURL(filePath: string, parsed: Record<string, unknown>): void {
  if (!("baseURL" in parsed) || parsed.baseURL === undefined) return;
  if (typeof parsed.baseURL !== "string" || parsed.baseURL.length === 0) {
    throw new ProfileError(
      "profile.invalidJson",
      `Profile at ${filePath} field "baseURL" must be a non-empty string`,
    );
  }
  let url: URL;
  try {
    url = new URL(parsed.baseURL);
  } catch {
    throw new ProfileError(
      "profile.invalidJson",
      `Profile at ${filePath} field "baseURL" must be an absolute URL`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProfileError(
      "profile.invalidJson",
      `Profile at ${filePath} field "baseURL" must use http or https`,
    );
  }
}

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
    assertBaseURL(filePath, parsed as Record<string, unknown>);
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
