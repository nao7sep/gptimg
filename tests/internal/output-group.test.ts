import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertOutputGroupAvailable,
  createOutputGroup,
  plannedImagePaths,
  sidecarPath,
  siblingsOnDisk,
} from "../../src/internal/output-group.js";

describe("OutputGroup", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-group-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("derives planned image paths and sidecar path from group fields", () => {
    const group = createOutputGroup(tmp, "stem", "png");
    expect(sidecarPath(group)).toBe(path.join(tmp, "stem.json"));
    expect(plannedImagePaths(group, 1, 1)).toEqual([path.join(tmp, "stem.png")]);
    expect(plannedImagePaths(group, 3, 3)).toEqual([
      path.join(tmp, "stem-1.png"),
      path.join(tmp, "stem-2.png"),
      path.join(tmp, "stem-3.png"),
    ]);
    expect(plannedImagePaths(group, 2, 12)).toEqual([
      path.join(tmp, "stem-01.png"),
      path.join(tmp, "stem-02.png"),
    ]);
  });

  it("siblingsOnDisk returns empty when the directory does not exist", () => {
    const group = createOutputGroup(path.join(tmp, "missing"), "stem", "png");
    expect(siblingsOnDisk(group)).toEqual([]);
  });

  it("matches stem.<ext>, stem-<digits>.<ext>, and stem.json; ignores unrelated names", async () => {
    const names = [
      "stem.png",
      "stem-1.png",
      "stem-01.png",
      "stem-10.png",
      "stem.json",
      "stem-mask.png",
      "stem-verify-preview.png",
      "other.png",
      "stemX.png",
    ];
    for (const name of names) {
      await writeFile(path.join(tmp, name), "");
    }
    const group = createOutputGroup(tmp, "stem", "png");
    expect(siblingsOnDisk(group).map((p) => path.basename(p)).sort()).toEqual([
      "stem-01.png",
      "stem-1.png",
      "stem-10.png",
      "stem.json",
      "stem.png",
    ]);
  });

  it("escapes regex metacharacters in stem", async () => {
    await writeFile(path.join(tmp, "a.b.png"), "");
    await writeFile(path.join(tmp, "axb.png"), "");
    const group = createOutputGroup(tmp, "a.b", "png");
    expect(siblingsOnDisk(group).map((p) => path.basename(p))).toEqual(["a.b.png"]);
  });

  describe("assertOutputGroupAvailable", () => {
    it("passes when the group is empty on disk", () => {
      const group = createOutputGroup(tmp, "stem", "png");
      const planned = [path.join(tmp, "stem.png"), path.join(tmp, "stem.json")];
      expect(() => assertOutputGroupAvailable(group, planned, false)).not.toThrow();
      expect(() => assertOutputGroupAvailable(group, planned, true)).not.toThrow();
    });

    it("throws output.exists without overwrite when any group sibling is present", async () => {
      await writeFile(path.join(tmp, "stem.png"), "");
      const group = createOutputGroup(tmp, "stem", "png");
      const planned = [path.join(tmp, "stem.png"), path.join(tmp, "stem.json")];
      expect(() => assertOutputGroupAvailable(group, planned, false)).toThrow(
        /Output exists/,
      );
    });

    it("blocks --overwrite when stale siblings exist that the plan would not replace", async () => {
      for (const name of ["stem-01.png", "stem-02.png", "stem.json"]) {
        await writeFile(path.join(tmp, name), "");
      }
      const group = createOutputGroup(tmp, "stem", "png");
      const planned = [
        path.join(tmp, "stem-1.png"),
        path.join(tmp, "stem.json"),
      ];
      expect(() => assertOutputGroupAvailable(group, planned, true)).toThrow(
        /output\.staleSiblings|stale|prior run|staleSiblings/,
      );
    });

    it("allows --overwrite when the plan supersedes every existing sibling", async () => {
      for (const name of ["stem-1.png", "stem-2.png", "stem.json"]) {
        await writeFile(path.join(tmp, name), "");
      }
      const group = createOutputGroup(tmp, "stem", "png");
      const planned = [
        path.join(tmp, "stem-1.png"),
        path.join(tmp, "stem-2.png"),
        path.join(tmp, "stem.json"),
      ];
      expect(() => assertOutputGroupAvailable(group, planned, true)).not.toThrow();
    });

    it("rejects internal duplicates in the planned set", async () => {
      const group = createOutputGroup(tmp, "stem", "png");
      const planned = [
        path.join(tmp, "stem-1.png"),
        path.join(tmp, "stem-1.png"),
      ];
      expect(() => assertOutputGroupAvailable(group, planned, true)).toThrow(
        /Multiple planned outputs/,
      );
    });

    it("ignores chroma-derived siblings (-mask, -verify-preview) as not group members", async () => {
      await mkdir(tmp, { recursive: true });
      for (const name of ["stem-mask.png", "stem-verify-preview.png"]) {
        await writeFile(path.join(tmp, name), "");
      }
      const group = createOutputGroup(tmp, "stem", "png");
      const planned = [path.join(tmp, "stem.png"), path.join(tmp, "stem.json")];
      expect(() => assertOutputGroupAvailable(group, planned, false)).not.toThrow();
      expect(() => assertOutputGroupAvailable(group, planned, true)).not.toThrow();
    });
  });
});
