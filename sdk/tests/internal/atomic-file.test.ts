import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupPublishedTemp, publishFileNoClobber, stagingPathFor, writeFileAtomic } from "../../src/internal/atomic-file.ts";
import { useReportedPlatform } from "../helpers/platform.ts";

describe("stagingPathFor", () => {
  it("names the staged file <stem>-<random>.tmp, in the target's own directory", () => {
    const target = path.join("/some/dir", "profile.json");
    const p = stagingPathFor(target);
    expect(path.dirname(p)).toBe(path.dirname(target));
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
  const reportPlatform = useReportedPlatform();
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-atomic-file-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("writes the content to the target path", async () => {
    const target = path.join(tmp, "out.txt");
    await writeFileAtomic(target, "hello world", { overwrite: true });
    expect(await readFile(target, "utf-8")).toBe("hello world");
  });

  it("writes Buffer/Uint8Array content unchanged", async () => {
    const target = path.join(tmp, "out.bin");
    const data = Buffer.from([1, 2, 3, 4]);
    await writeFileAtomic(target, data, { overwrite: true });
    expect(await readFile(target)).toEqual(data);
  });

  it("overwrites an existing target with entirely new content", async () => {
    const target = path.join(tmp, "config.json");
    await writeFileAtomic(target, "first", { overwrite: true });
    await writeFileAtomic(target, "second", { overwrite: true });
    expect(await readFile(target, "utf-8")).toBe("second");
  });

  it("skips an overwrite whose content is identical, leaving the file itself in place", async () => {
    const target = path.join(tmp, "same.json");
    await writeFileAtomic(target, "same", { overwrite: true });
    const before = await stat(target);

    await writeFileAtomic(target, Buffer.from("same", "utf-8"), { overwrite: true });

    const after = await stat(target);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readdir(tmp)).toEqual(["same.json"]);
  });

  it.skipIf(process.platform === "win32")("keeps the replaced file's permission mode when content changes", async () => {
    const target = path.join(tmp, "shared.png");
    await writeFileAtomic(target, "first", { overwrite: true });
    await chmod(target, 0o640);

    await writeFileAtomic(target, "second", { overwrite: true });

    expect(await readFile(target, "utf-8")).toBe("second");
    expect((await stat(target)).mode & 0o777).toBe(0o640);
  });

  it.skipIf(process.platform === "win32")("does not carry the replaced file's mode on Windows, whose mode holds only a read-only bit", async () => {
    const fresh = path.join(tmp, "fresh.png");
    await writeFileAtomic(fresh, "fresh", { overwrite: true });
    const target = path.join(tmp, "shared.png");
    await writeFileAtomic(target, "first", { overwrite: true });
    await chmod(target, 0o640);

    reportPlatform("win32");
    await writeFileAtomic(target, "second", { overwrite: true });

    expect(await readFile(target, "utf-8")).toBe("second");
    expect((await stat(target)).mode & 0o777).toBe((await stat(fresh)).mode & 0o777);
  });

  it("atomically refuses to replace a target when overwrite is false", async () => {
    const target = path.join(tmp, "claimed.txt");
    await writeFileAtomic(target, "winner", { overwrite: true });

    await expect(writeFileAtomic(target, "loser", { overwrite: false })).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await readFile(target, "utf-8")).toBe("winner");
    expect(await readdir(tmp)).toEqual(["claimed.txt"]);
  });

  it("renames the staged file in once the name is free when the filesystem has no hard links, never copying", async () => {
    const temp = path.join(tmp, "fallback.tmp");
    const target = path.join(tmp, "fallback.txt");
    await writeFile(temp, "winner", "utf-8");
    const unsupportedLink = vi.fn(async () => {
      throw Object.assign(new Error("hard links unsupported"), {
        code: "EPERM",
      });
    });

    await expect(publishFileNoClobber(temp, target, unsupportedLink)).resolves.toEqual({ tempRemains: false });
    expect(await readFile(target, "utf-8")).toBe("winner");
    expect(await readdir(tmp)).toEqual(["fallback.txt"]);

    await writeFile(temp, "loser", "utf-8");
    await expect(publishFileNoClobber(temp, target, unsupportedLink)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(target, "utf-8")).toBe("winner");
  });

  it("treats target publication as committed even when temp cleanup fails", async () => {
    const cleanup = vi.fn(async () => {
      throw Object.assign(new Error("busy temp"), { code: "EPERM" });
    });
    await expect(cleanupPublishedTemp("/published.tmp", cleanup)).resolves.toBeUndefined();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("leaves no stray temp file behind after a successful write", async () => {
    const target = path.join(tmp, "clean.txt");
    await writeFileAtomic(target, "x", { overwrite: true });
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

    await expect(writeFileAtomic(targetDir, "x", { overwrite: true })).rejects.toThrow();

    const entries = await readdir(tmp);
    // Only the pre-existing directory remains; no leftover `<stem>-<random>.tmp`.
    expect(entries).toEqual(["actually-a-dir"]);
  });
});
