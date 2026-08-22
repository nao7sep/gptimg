import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireOutputGroupLock,
  assertOutputGroupAvailable,
  assertStemAvailable,
  createOutputGroup,
  plannedSidecarPaths,
  outputGroupLockPathFor,
  settleOutputPublications,
  sidecarPathFor,
  siblingsOnDisk,
  withOutputGroupLock,
} from "../../src/internal/output-group.js";

describe("OutputGroup", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-group-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("derives per-image sidecar paths from group fields", () => {
    const group = createOutputGroup(tmp, "stem", "png");
    expect(sidecarPathFor(group, 1, 1)).toBe(path.join(tmp, "stem.json"));
    expect(plannedSidecarPaths(group, 1, 1)).toEqual([path.join(tmp, "stem.json")]);
    expect(plannedSidecarPaths(group, 3, 3)).toEqual([
      path.join(tmp, "stem-1.json"),
      path.join(tmp, "stem-2.json"),
      path.join(tmp, "stem-3.json"),
    ]);
    expect(plannedSidecarPaths(group, 2, 12)).toEqual([path.join(tmp, "stem-01.json"), path.join(tmp, "stem-02.json")]);
  });

  it("normalizes lexical aliases of the same target stem", () => {
    expect(createOutputGroup(tmp, "same", "png")).toEqual(
      createOutputGroup(tmp, "nested/../same", "png"),
    );
    expect(createOutputGroup(tmp, "./same", "png")).toEqual(
      createOutputGroup(tmp, "same", "png"),
    );
  });

  it("siblingsOnDisk returns empty when the directory does not exist", () => {
    const group = createOutputGroup(path.join(tmp, "missing"), "stem", "png");
    expect(siblingsOnDisk(group)).toEqual([]);
  });

  it("matches stem.<ext>, stem-<digits>.<ext>, stem.json, and stem-<digits>.json; ignores unrelated names", async () => {
    const names = [
      "stem.png",
      "stem.jpg",
      "stem.webp",
      "stem-1.png",
      "stem-01.png",
      "stem-10.png",
      "stem.json",
      "stem-01.json",
      "stem-10.json",
      "stem-mask.png",
      "other.png",
      "stemX.png",
    ];
    for (const name of names) {
      await writeFile(path.join(tmp, name), "");
    }
    const group = createOutputGroup(tmp, "stem", "png");
    expect(
      siblingsOnDisk(group)
        .map((p) => path.basename(p))
        .sort(),
    ).toEqual([
      "stem-01.json",
      "stem-01.png",
      "stem-1.png",
      "stem-10.json",
      "stem-10.png",
      "stem.jpg",
      "stem.json",
      "stem.png",
      "stem.webp",
    ]);
  });

  it("matches case-differing siblings (Photo group detects a photo output)", async () => {
    for (const name of ["photo.png", "PHOTO-1.png", "Photo.json"]) {
      await writeFile(path.join(tmp, name), "");
    }
    const group = createOutputGroup(tmp, "Photo", "png");
    expect(
      siblingsOnDisk(group)
        .map((p) => path.basename(p))
        .sort(),
    ).toEqual(["PHOTO-1.png", "Photo.json", "photo.png"]);
  });

  it("escapes regex metacharacters in stem", async () => {
    await writeFile(path.join(tmp, "a.b.png"), "");
    await writeFile(path.join(tmp, "axb.png"), "");
    const group = createOutputGroup(tmp, "a.b", "png");
    expect(siblingsOnDisk(group).map((p) => path.basename(p))).toEqual(["a.b.png"]);
  });

  it("serializes concurrent publication for the same case-folded stem", async () => {
    const group = createOutputGroup(tmp, "Photo", "png");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = withOutputGroupLock(group, async () => {
      entered();
      await held;
      return "first";
    });
    await started;

    await expect(withOutputGroupLock(createOutputGroup(tmp, "photo", "jpg"), async () => "second")).rejects.toMatchObject({
      code: "output.busy",
    });
    release();
    await expect(first).resolves.toBe("first");
    await expect(withOutputGroupLock(group, async () => "next")).resolves.toBe("next");
  });

  it("serializes aliases of the same physical output directory", async () => {
    const realDir = path.join(tmp, "real");
    const aliasDir = path.join(tmp, "alias");
    await mkdir(realDir);
    await symlink(realDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
    const realGroup = createOutputGroup(realDir, "same", "png");
    const aliasGroup = createOutputGroup(aliasDir, "same", "jpg");

    expect(await outputGroupLockPathFor(realGroup)).toBe(await outputGroupLockPathFor(aliasGroup));
    const first = await acquireOutputGroupLock(realGroup);
    try {
      await expect(withOutputGroupLock(aliasGroup, async () => "second")).rejects.toMatchObject({
        code: "output.busy",
      });
    } finally {
      await first.release();
    }
  });

  it("recovers an abandoned lock without relying on a reusable process id", async () => {
    const group = createOutputGroup(tmp, "crashed", "png");
    const lockPath = await outputGroupLockPathFor(group);
    await mkdir(lockPath);
    await writeFile(path.join(lockPath, "held-aaaaaaaaaaaaaaaaaaaaa"), "");

    await expect(withOutputGroupLock(group, async () => "recovered")).resolves.toBe("recovered");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("recovers a released lock even when cleanup failed", async () => {
    const group = createOutputGroup(tmp, "released", "png");
    const lockPath = await outputGroupLockPathFor(group);
    await mkdir(lockPath);
    await writeFile(path.join(lockPath, "held-bbbbbbbbbbbbbbbbbbbbb"), "");
    await writeFile(path.join(lockPath, "released-bbbbbbbbbbbbbbbbbbbbb"), "");

    await expect(withOutputGroupLock(group, async () => "recovered")).resolves.toBe(
      "recovered",
    );
    expect(existsSync(lockPath)).toBe(false);
  });

  it("waits for every publisher and reports failures in plan order", async () => {
    let releaseSecond!: () => void;
    const secondHeld = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let settled = false;
    const publication = settleOutputPublications([
      async () => {
        throw new Error("first failed");
      },
      async () => {
        await secondHeld;
        throw new Error("second failed");
      },
    ]).finally(() => {
      settled = true;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    releaseSecond();
    await expect(publication).rejects.toMatchObject({
      code: "output.publicationFailed",
      message: expect.stringMatching(/item 1: first failed; item 2: second failed/),
    });
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
      expect(() => assertOutputGroupAvailable(group, planned, false)).toThrow(/Output exists/);
    });

    it("blocks --overwrite when stale siblings exist that the plan would not replace", async () => {
      for (const name of ["stem-01.png", "stem-02.png", "stem.json"]) {
        await writeFile(path.join(tmp, name), "");
      }
      const group = createOutputGroup(tmp, "stem", "png");
      const planned = [path.join(tmp, "stem-1.png"), path.join(tmp, "stem.json")];
      expect(() => assertOutputGroupAvailable(group, planned, true)).toThrow(/output\.staleSiblings|stale|prior run|staleSiblings/);
    });

    it("allows --overwrite when the plan supersedes every existing sibling", async () => {
      for (const name of ["stem-1.png", "stem-2.png", "stem.json"]) {
        await writeFile(path.join(tmp, name), "");
      }
      const group = createOutputGroup(tmp, "stem", "png");
      const planned = [path.join(tmp, "stem-1.png"), path.join(tmp, "stem-2.png"), path.join(tmp, "stem.json")];
      expect(() => assertOutputGroupAvailable(group, planned, true)).not.toThrow();
    });

    it("allows --overwrite to supersede the same image slot in another supported format", async () => {
      await writeFile(path.join(tmp, "stem.jpg"), "");
      await writeFile(path.join(tmp, "stem.json"), "");
      const group = createOutputGroup(tmp, "stem", "png");
      const planned = [path.join(tmp, "stem.png"), path.join(tmp, "stem.json")];
      expect(() => assertOutputGroupAvailable(group, planned, true)).not.toThrow();
    });

    it("does not let a sidecar-only plan absorb an orphan image under overwrite", async () => {
      await writeFile(path.join(tmp, "stem.png"), "");
      const group = createOutputGroup(tmp, "stem", "json");
      expect(() =>
        assertOutputGroupAvailable(group, [path.join(tmp, "stem.json")], true),
      ).toThrow(/prior run/);
    });

    it("rejects internal duplicates in the planned set", async () => {
      const group = createOutputGroup(tmp, "stem", "png");
      const planned = [path.join(tmp, "stem-1.png"), path.join(tmp, "stem-1.png")];
      expect(() => assertOutputGroupAvailable(group, planned, true)).toThrow(/Multiple planned outputs/);
    });

    it("ignores chroma-derived siblings (-mask, -cutout) as not group members", async () => {
      await mkdir(tmp, { recursive: true });
      for (const name of ["stem-mask.png", "stem-cutout.png"]) {
        await writeFile(path.join(tmp, name), "");
      }
      const group = createOutputGroup(tmp, "stem", "png");
      const planned = [path.join(tmp, "stem.png"), path.join(tmp, "stem.json")];
      expect(() => assertOutputGroupAvailable(group, planned, false)).not.toThrow();
      expect(() => assertOutputGroupAvailable(group, planned, true)).not.toThrow();
    });
  });

  describe("assertStemAvailable (pre-call fail-fast)", () => {
    it("passes when no sidecars exist", () => {
      expect(() => assertStemAvailable(tmp, "stem", 2, false)).not.toThrow();
    });

    it("throws output.exists without overwrite when a sidecar is present", async () => {
      await writeFile(path.join(tmp, "stem.json"), "");
      expect(() => assertStemAvailable(tmp, "stem", 1, false)).toThrow(/Output exists/);
    });

    it("throws output.exists without overwrite when only an image remnant is present", async () => {
      await writeFile(path.join(tmp, "stem.webp"), "");
      expect(() => assertStemAvailable(tmp, "stem", 1, false)).toThrow(/Output exists/);
    });

    it("throws on stale prior sidecars under overwrite when the plan shrinks", async () => {
      await writeFile(path.join(tmp, "stem-1.json"), "");
      await writeFile(path.join(tmp, "stem-2.json"), "");
      expect(() => assertStemAvailable(tmp, "stem", 1, true)).toThrow(/prior run/);
    });
  });
});
