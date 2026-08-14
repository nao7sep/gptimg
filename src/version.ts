/**
 * The toolkit's own version, for a caller that needs to know which gptimg it
 * holds. Read from the adjacent package.json rather than restated as a literal:
 * package.json is the version's single source of truth for this stack, and a
 * literal that could have been derived silently drifts from it.
 *
 * The read is safe to do here because gptimg is consumed from source and packed
 * as a tarball, so package.json is always the sibling of src/ in both shapes. It
 * happens once at module load, not per call.
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
    throw new Error(`gptimg package.json is missing a version string: ${packagePath}`);
  }
  return version;
}

/** The running toolkit's semantic version, e.g. "0.1.0". */
export const VERSION: string = readPackageVersion();
