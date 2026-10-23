// A volume that cannot flush a folder (some network shares and FUSE file
// systems answer EINVAL or ENOTSUP) still publishes; any other failure to
// flush is the filesystem's error.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const folderSync = vi.hoisted(() => ({ code: null as string | null }));
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      if (folderSync.code !== null && args[1] === "r") {
        const code = folderSync.code;
        handle.sync = async () => {
          throw Object.assign(new Error(`${code}: folder sync`), { code });
        };
      }
      return handle;
    },
  };
});

const { writeFileAtomic } = await import("../../src/internal/atomic-file.ts");

describe.skipIf(process.platform === "win32")("flushing the output folder", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-folder-sync-"));
  });
  afterEach(async () => {
    folderSync.code = null;
    await rm(tmp, { recursive: true, force: true });
  });

  it.each(["EINVAL", "ENOTSUP"])("publishes on a volume that answers %s", async (code) => {
    folderSync.code = code;
    const target = path.join(tmp, "out.txt");
    await writeFileAtomic(target, "kept", { overwrite: false });
    expect(await readFile(target, "utf8")).toBe("kept");
  });

  it("fails with any other folder-flush error", async () => {
    folderSync.code = "EIO";
    await expect(writeFileAtomic(path.join(tmp, "out.txt"), "x", { overwrite: false })).rejects.toMatchObject({ code: "EIO" });
  });
});
