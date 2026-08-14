import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";
import * as publicApi from "../src/index.js";

// gptimg is an SDK consumed from source, so a caller cannot ask npm which build
// it holds — the app-release-conventions therefore require an exported VERSION.
// These pin the two things that make it trustworthy: that it is DERIVED from
// package.json (the stack's single source of truth) rather than a literal that
// drifts on the next bump, and that it is actually reachable from the package
// entry point, since an unexported constant answers nobody.

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/;

function manifestVersion(): string {
  const raw = readFileSync(join(process.cwd(), "package.json"), "utf-8");
  return (JSON.parse(raw) as { version: string }).version;
}

describe("VERSION", () => {
  it("equals the version declared in package.json", () => {
    expect(VERSION).toBe(manifestVersion());
  });

  it("is a well-formed semantic version", () => {
    expect(VERSION).toMatch(SEMVER);
  });

  it("is re-exported from the package entry point", () => {
    expect(publicApi.VERSION).toBe(VERSION);
  });
});
