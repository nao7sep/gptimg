import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stagingPathFor, writeFileAtomic } from "../../src/internal/atomic-file.js";

describe("stagingPathFor", () => {
  it("names the staged file <stem>-<random>.tmp, in the target's own directory", () => {
    const target = path.join("/some/dir", "profile.json");
    const p = stagingPathFor(target);
    expect(path.dirname(p)).toBe("/some/dir");
    expect(path.basename(p)).toMatch(/^profile-[A-Za-z0-9_-]{21}\.tmp$/);
  });

  it("uses the full stem for a multi-dot filename (one extension stripped)", () => {
    const p = stagingPathFor("/a/foo.tar.gz");
    expect(path.basename(p)).toMatch(/^foo\.tar-[A-Za-z0-9_-]{21}\.tmp$/);
  });

  it("produces a distinct discriminator on each call", () => {
    const a = stagingPathFor("/a/foo.json");
    const b = stagingPathFor("/a/foo.json");
    expect(a).not.toBe(b);
  });
});

describe("writeFileAtomic", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-atomic-file-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("writes the content to the target path", async () => {
    const target = path.join(tmp, "out.txt");
    await writeFileAtomic(target, "hello world", { encoding: "utf-8" });
    expect(await readFile(target, "utf-8")).toBe("hello world");
  });

  it("writes Buffer/Uint8Array content unchanged", async () => {
    const target = path.join(tmp, "out.bin");
    const data = Buffer.from([1, 2, 3, 4]);
    await writeFileAtomic(target, data);
    expect(await readFile(target)).toEqual(data);
  });

  it("honors the mode option", async () => {
    const target = path.join(tmp, "secret.json");
    await writeFileAtomic(target, "{}", { encoding: "utf-8", mode: 0o600 });
    const info = await stat(target);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("overwrites an existing target with entirely new content", async () => {
    const target = path.join(tmp, "config.json");
    await writeFileAtomic(target, "first", { encoding: "utf-8" });
    await writeFileAtomic(target, "second", { encoding: "utf-8" });
    expect(await readFile(target, "utf-8")).toBe("second");
  });

  it("leaves no stray temp file behind after a successful write", async () => {
    const target = path.join(tmp, "clean.txt");
    await writeFileAtomic(target, "x", { encoding: "utf-8" });
    const entries = await readdir(tmp);
    expect(entries).toEqual(["clean.txt"]);
  });

  it("cleans up the temp file and leaves no partial target when the rename fails", async () => {
    // Renaming a regular file onto an existing directory fails (EISDIR/ENOTDIR
    // depending on platform), so this exercises the writeFile-succeeds,
    // rename-fails path without needing to mock fs.
    const targetDir = path.join(tmp, "actually-a-dir");
    await rm(targetDir, { recursive: true, force: true });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(targetDir);

    await expect(writeFileAtomic(targetDir, "x", { encoding: "utf-8" })).rejects.toThrow();

    const entries = await readdir(tmp);
    // Only the pre-existing directory remains; no leftover `<stem>-<random>.tmp`.
    expect(entries).toEqual(["actually-a-dir"]);
  });
});
