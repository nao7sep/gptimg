import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function expectedReleaseTag(version: string): string {
  return `v${version}`;
}

export function assertReleaseTag(tag: string, version: string): void {
  const expected = expectedReleaseTag(version);
  if (tag !== expected) {
    throw new Error(`Release tag ${JSON.stringify(tag)} does not match package version ${expected}.`);
  }
}

function main(): void {
  const tag = process.argv[2];
  if (!tag) throw new Error("Usage: npm run check:release-tag -- <tag>");
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const manifest = JSON.parse(
    readFileSync(path.join(scriptDir, "..", "package.json"), "utf-8"),
  ) as { version?: unknown };
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("package.json is missing a version string.");
  }
  assertReleaseTag(tag, manifest.version);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) main();
