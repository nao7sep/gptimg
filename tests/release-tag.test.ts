import { describe, expect, it } from "vitest";
import { assertReleaseTag, expectedReleaseTag } from "../scripts/check-release-tag.js";

describe("release tag gate", () => {
  it("derives the expected tag from the package version", () => {
    expect(expectedReleaseTag("1.2.3")).toBe("v1.2.3");
  });

  it("accepts only the exact version tag", () => {
    expect(() => assertReleaseTag("v1.2.3", "1.2.3")).not.toThrow();
    expect(() => assertReleaseTag("v9.9.9", "1.2.3")).toThrow(/does not match/);
  });
});
