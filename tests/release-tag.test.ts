import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertReleaseTag, expectedReleaseTag } from "../scripts/check-release-tag.js";

const releaseWorkflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

describe("release tag gate", () => {
  it("derives the expected tag from the package version", () => {
    expect(expectedReleaseTag("1.2.3")).toBe("v1.2.3");
  });

  it("accepts only the exact version tag", () => {
    expect(() => assertReleaseTag("v1.2.3", "1.2.3")).not.toThrow();
    expect(() => assertReleaseTag("v9.9.9", "1.2.3")).toThrow(/does not match/);
  });

  it("passes the untrusted tag to the shell as environment data", () => {
    expect(releaseWorkflow).toContain("GPTIMG_RELEASE_TAG: ${{ github.ref_name }}");
    expect(releaseWorkflow).toContain('run: npm run check:release-tag -- "$GPTIMG_RELEASE_TAG"');
    expect(releaseWorkflow).not.toMatch(/run:.*\$\{\{\s*github\.ref_name\s*\}\}/);
  });
});
