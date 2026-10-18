/**
 * The SDK's own version, for a caller that needs to know which gptimgsdk it
 * holds. Read from the package's own package.json rather than restated as a
 * literal: package.json is the version's single source of truth for this stack,
 * and a literal that could have been derived silently drifts from it.
 *
 * The read is safe here because gptimgsdk is consumed from source, and an app
 * bundling it carries its package.json, so the manifest is always the sibling of
 * src/. It happens once at module load, not per call.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readPackageVersion(): string {
  const packagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const parsed: unknown = JSON.parse(readFileSync(packagePath, "utf-8"));
  const version =
    parsed && typeof parsed === "object" ? (parsed as { version?: unknown }).version : undefined;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`gptimgsdk package.json is missing a version string: ${packagePath}`);
  }
  return version;
}

/** The running SDK's semantic version, e.g. "1.2.3". */
export const VERSION: string = readPackageVersion();
