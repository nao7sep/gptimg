import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.ts";
import * as publicApi from "../src/index.ts";

// gptimg is an SDK consumed from source, so a caller cannot ask npm which build
// it holds — the app-release-conventions therefore require an exported VERSION.
// It is read from package.json by a JSON import (src/version.ts); these pin that
// it equals the manifest's version and that the package entry exports it.

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/;

function manifestVersion(): string {
  const raw = readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf-8");
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
