import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { copyFileAtomic, writeTextAtomic } from "../../src/main/files.ts";

vi.mock("node:fs/promises", async (actual) => {
  const original = await actual<typeof fs>();
  return { ...original, open: vi.fn(original.open), rename: vi.fn(original.rename) };
});
afterEach(() => vi.restoreAllMocks());
const root = () => mkdtempSync(join(tmpdir(), "gptimg-files-"));

describe("atomic files", () => {
  it("preserves unchanged times and replacement permissions", async () => {
    const file = join(root(), "a.json");
    writeFileSync(file, "old", { mode: 0o600 });
    const before = statSync(file).mtimeMs;
    expect(await writeTextAtomic(file, "old")).toBe(false);
    expect(statSync(file).mtimeMs).toBe(before);
    expect(await writeTextAtomic(file, "new")).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("new");
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      await writeTextAtomic(file, "public", 0o644);
      expect(statSync(file).mode & 0o777).toBe(0o644);
      await writeTextAtomic(file, "secret", 0o600);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("refuses replacing a target whose current content cannot be read", async () => {
    const file = join(root(), "a.json");
    mkdirSync(file);
    await expect(writeTextAtomic(file, "new")).rejects.toBeDefined();
    expect(statSync(file).isDirectory()).toBe(true);
    expect(readdirSync(join(file, ".."))).toEqual(["a.json"]);
  });

  it("keeps old content and removes its staging file on publication failure", async () => {
    const dir = root();
    const file = join(dir, "a.json");
    writeFileSync(file, "old");
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("rename failed"));
    await expect(writeTextAtomic(file, "new")).rejects.toThrow("rename failed");
    expect(readFileSync(file, "utf8")).toBe("old");
    expect(readdirSync(dir)).toEqual(["a.json"]);
  });

  it("keeps old content when flushing staged bytes fails", async () => {
    const dir = root();
    const file = join(dir, "a.json");
    writeFileSync(file, "old");
    const actualOpen = vi.mocked(fs.open).getMockImplementation()!;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actualOpen(...args);
      vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("flush failed"));
      return handle;
    });
    await expect(writeTextAtomic(file, "new")).rejects.toThrow("flush failed");
    expect(readFileSync(file, "utf8")).toBe("old");
    expect(readdirSync(dir)).toEqual(["a.json"]);
  });

  it("cleans up a copied reference when publication fails", async () => {
    const dir = root();
    const source = join(dir, "source.png");
    writeFileSync(source, "source");
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("publication failed"));
    await expect(copyFileAtomic(source, join(dir, "target.png"))).rejects.toThrow("publication failed");
    expect(readdirSync(dir)).toEqual(["source.png"]);
  });

  it("never publishes a failed copy", async () => {
    const dir = root();
    const target = join(dir, "image.png");
    await expect(copyFileAtomic(join(dir, "missing.png"), target)).rejects.toBeDefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("does not delete another writer's file when its exclusive claim fails", async () => {
    const dir = root();
    const foreign = join(dir, "foreign.tmp");
    writeFileSync(foreign, "other work");
    vi.mocked(fs.open).mockImplementationOnce(async (path) => {
      writeFileSync(String(path), "other work");
      throw Object.assign(new Error("collision"), { code: "EEXIST" });
    });
    await expect(writeTextAtomic(join(dir, "a.json"), "new")).rejects.toMatchObject({ code: "EEXIST" });
    expect(readdirSync(dir)).toHaveLength(2);
    for (const file of readdirSync(dir)) expect(readFileSync(join(dir, file), "utf8")).toBe("other work");
  });
});
