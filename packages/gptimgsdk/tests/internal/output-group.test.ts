import { link, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { lstatSync, statSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertOutputGroupAvailable,
  assertStemAvailable,
  createOutputGroup,
  plannedSidecarPaths,
  refuseCaseOnlyRename,
  reserveOutputGroup,
  settleOutputPublications,
  sidecarPathFor,
  siblingsOnDisk,
} from "../../src/internal/output-group.ts";

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

  it.each([
    ["cafe\u0301", "caf\u00e9"],
    ["caf\u00e9", "cafe\u0301"],
  ])("compares normalized siblings but returns their actual paths (%s against %s)", async (existing, planned) => {
    const names = [`${existing}.png`, `${existing}.json`, `${existing}-01.webp`, `${existing}-01.json`];
    for (const name of [...names, `${existing}-mask.png`, `${existing}X.png`]) {
      await writeFile(path.join(tmp, name), "");
    }
    // Directory discovery is the I/O authority, including a filesystem's own
    // normalization of the names supplied to writeFile.
    const discovered = (await readdir(tmp)).filter((name) => names.some((expected) =>
      expected.normalize("NFC") === name.normalize("NFC"),
    ));
    const group = createOutputGroup(tmp, planned, "png");
    expect(siblingsOnDisk(group)).toEqual(discovered.map((name) => path.join(tmp, name)).sort());
    expect(() => assertStemAvailable(tmp, planned, 1, false)).toThrow(
      expect.objectContaining({ code: "output.exists" }),
    );
    expect(() => assertStemAvailable(tmp, planned, 1, true)).toThrow(
      expect.objectContaining({ code: "output.staleSiblings" }),
    );
  });

  it.each([
    ["cafe\u0301", "caf\u00e9"],
    ["caf\u00e9", "cafe\u0301"],
  ])("admits equivalent Unicode spellings only for the same numbered entries (%s against %s)", async (existing, planned) => {
    for (const index of [1, 2]) {
      await writeFile(path.join(tmp, `${existing}-${index}.jpg`), "old image");
      await writeFile(path.join(tmp, `${existing}-${index}.json`), "{}");
    }
    const group = createOutputGroup(tmp, planned, "png");
    const files = [1, 2].flatMap((index) => [path.join(tmp, `${planned}-${index}.png`), path.join(tmp, `${planned}-${index}.json`)]);
    const requestedSpelling = statSync(path.join(tmp, `${planned}-1.jpg`), { throwIfNoEntry: false });
    const actualFile = statSync(path.join(tmp, `${existing}-1.jpg`));
    if (requestedSpelling?.ino === actualFile.ino && requestedSpelling.dev === actualFile.dev) {
      expect(() => assertOutputGroupAvailable(group, files, true)).not.toThrow();
    } else {
      expect(() => assertOutputGroupAvailable(group, files, true)).toThrow(
        expect.objectContaining({ code: "output.normalizationConflict" }),
      );
    }
    const caseChangedGroup = createOutputGroup(tmp, planned.toUpperCase(), "png");
    const caseChangedFiles = files.map((file) => path.join(tmp, path.basename(file).toUpperCase()));
    expect(() => assertOutputGroupAvailable(caseChangedGroup, caseChangedFiles, true)).toThrow(
      expect.objectContaining({ code: "output.caseConflict" }),
    );
  });

  it("refuses two distinct canonically equivalent entries, even if they are hard links", async () => {
    const existing = path.join(tmp, "cafe\u0301.png");
    const planned = path.join(tmp, "caf\u00e9.png");
    await writeFile(existing, "old image");
    const group = createOutputGroup(tmp, "caf\u00e9", "png");
    if (statSync(planned, { throwIfNoEntry: false }) === undefined) {
      await link(existing, planned);
      expect(() => assertOutputGroupAvailable(group, [planned], true)).toThrow(
        expect.objectContaining({ code: "output.normalizationConflict" }),
      );
      expect(await readdir(tmp)).toHaveLength(2);
    } else {
      // This volume treats the two spellings as one actual directory entry.
      expect(() => assertOutputGroupAvailable(group, [planned], true)).not.toThrow();
      expect(await readdir(tmp)).toHaveLength(1);
    }
  });

  it("compares dangling symlink entries without following their missing target", async () => {
    const existing = path.join(tmp, "cafe\u0301.png");
    const planned = path.join(tmp, "caf\u00e9.png");
    const missing = path.join(tmp, "missing.png");
    await symlink(missing, existing);
    const group = createOutputGroup(tmp, "caf\u00e9", "png");
    if (lstatSync(planned, { throwIfNoEntry: false }) === undefined) {
      // Two entries stay distinct even when both symlinks name one target.
      await symlink(missing, planned);
      expect(() => assertOutputGroupAvailable(group, [planned], true)).toThrow(
        expect.objectContaining({ code: "output.normalizationConflict" }),
      );
      expect(await readdir(tmp)).toHaveLength(2);
    } else {
      expect(() => assertOutputGroupAvailable(group, [planned], true)).not.toThrow();
      expect(await readdir(tmp)).toHaveLength(1);
    }
  });

  it("classifies a metadata inspection failure and preserves its filesystem cause", () => {
    const existing = path.join(tmp, "cafe\u0301.png");
    const planned = path.join(tmp, "caf\u00e9.png");
    // The directory snapshot can precede another writer removing the entry.
    expect(() => refuseCaseOnlyRename(existing, planned, [path.basename(existing)])).toThrow(
      expect.objectContaining({ code: "output.scanFailed", cause: expect.objectContaining({ code: "ENOENT" }) }),
    );
  });

  it("escapes regex metacharacters in stem", async () => {
    await writeFile(path.join(tmp, "a.b.png"), "");
    await writeFile(path.join(tmp, "axb.png"), "");
    const group = createOutputGroup(tmp, "a.b", "png");
    expect(siblingsOnDisk(group).map((p) => path.basename(p))).toEqual(["a.b.png"]);
  });

  it("refuses an overlapping reservation for the same case-folded stem until it is released", async () => {
    const first = await reserveOutputGroup(createOutputGroup(tmp, "Photo", "png"));
    await expect(reserveOutputGroup(createOutputGroup(tmp, "photo", "jpg"))).rejects.toMatchObject({
      code: "output.busy",
    });
    first.release();
    const next = await reserveOutputGroup(createOutputGroup(tmp, "photo", "jpg"));
    next.release();
  });

  it("refuses a stem that is a numbered slot of a live group, in either order", async () => {
    const group = await reserveOutputGroup(createOutputGroup(tmp, "foo", "json"));
    await expect(reserveOutputGroup(createOutputGroup(tmp, "foo-1", "json"))).rejects.toMatchObject({ code: "output.busy" });
    await expect(reserveOutputGroup(createOutputGroup(tmp, "FOO-02", "json"))).rejects.toMatchObject({ code: "output.busy" });
    group.release();

    const slot = await reserveOutputGroup(createOutputGroup(tmp, "foo-1", "json"));
    await expect(reserveOutputGroup(createOutputGroup(tmp, "foo", "json"))).rejects.toMatchObject({ code: "output.busy" });
    slot.release();
  });

  it("lets disjoint stems reserve concurrently", async () => {
    const held = await Promise.all(
      ["foo", "foo-", "foo-1a", "foobar", "foo-1-2", "bar"].map((stem) =>
        reserveOutputGroup(createOutputGroup(tmp, stem, "json")),
      ),
    );
    for (const reservation of held) reservation.release();
  });

  it("refuses the same stem through lexical and symlink aliases of one directory", async () => {
    const realDir = path.join(tmp, "real");
    const aliasDir = path.join(tmp, "alias");
    await mkdir(realDir);
    await symlink(realDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
    const first = await reserveOutputGroup(createOutputGroup(realDir, "same", "png"));
    try {
      await expect(reserveOutputGroup(createOutputGroup(aliasDir, "same", "jpg"))).rejects.toMatchObject({
        code: "output.busy",
      });
      await expect(reserveOutputGroup(createOutputGroup(tmp, "real/../real/same", "jpg"))).rejects.toMatchObject({
        code: "output.busy",
      });
      // The same stem in the parent directory is a different group.
      (await reserveOutputGroup(createOutputGroup(tmp, "same", "jpg"))).release();
    } finally {
      first.release();
    }
  });

  it("writes nothing to the output directory to reserve it", async () => {
    const reservation = await reserveOutputGroup(createOutputGroup(tmp, "quiet", "json"));
    expect(await readdir(tmp)).toEqual([]);
    reservation.release();
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

    it("refuses under --overwrite to replace a member whose name differs only in case", async () => {
      await writeFile(path.join(tmp, "Photo.png"), "");
      await writeFile(path.join(tmp, "Photo.json"), "{}");
      const group = createOutputGroup(tmp, "photo", "png");
      const planned = [path.join(tmp, "photo.png"), path.join(tmp, "photo.json")];
      expect(() => assertOutputGroupAvailable(group, planned, true)).toThrow(
        expect.objectContaining({ code: "output.caseConflict" }),
      );
    });

    it("refuses a same-format extension that differs only in case, and allows another format", async () => {
      await writeFile(path.join(tmp, "stem.PNG"), "");
      const group = createOutputGroup(tmp, "stem", "png");
      const planned = [path.join(tmp, "stem.png"), path.join(tmp, "stem.json")];
      expect(() => assertOutputGroupAvailable(group, planned, true)).toThrow(
        expect.objectContaining({ code: "output.caseConflict" }),
      );
      expect(() =>
        assertOutputGroupAvailable(group, [path.join(tmp, "stem.webp"), path.join(tmp, "stem.json")], true),
      ).not.toThrow();
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
