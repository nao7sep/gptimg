import { mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { decodeInProfileOf } from "../../src/image/bridge.ts";

const state = vi.hoisted(() => ({ stagingPath: "", closed: false }));
vi.mock("../../src/image/source-metadata.ts", () => ({
  readSourceMetadata: async () => ({ icc: Buffer.from("0000000000000000RGB ") }),
  embedSourceMetadata: (bytes: Buffer) => bytes,
}));
vi.mock("../../src/internal/atomic-file.ts", async (original) => ({
  ...await original<typeof import("../../src/internal/atomic-file.ts")>(),
  stagingPathFor: () => state.stagingPath,
}));
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return { ...real, open: async (...args: Parameters<typeof open>) => {
    const handle = await real.open(...args);
    if (args[0] === state.stagingPath) {
      const write = handle.writeFile.bind(handle);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "writeFile").mockImplementation(async () => {
        await write("partial");
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      });
      vi.spyOn(handle, "close").mockImplementation(async () => { await close(); state.closed = true; });
    }
    return handle;
  } };
});
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "gptimg-icc-staging-"));
  state.stagingPath = path.join(dir, "out-fixed.tmp");
  state.closed = false;
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it("closes and removes a profile created by a failed staging write", async () => {
  const use = vi.fn();
  await expect(decodeInProfileOf(path.join(dir, "in.png"), path.join(dir, "main.png"), path.join(dir, "out.png"), use))
    .rejects.toMatchObject({ code: "fs.noSpace" });
  expect(state.closed).toBe(true);
  expect(await readdir(dir)).toEqual([]);
  expect(use).not.toHaveBeenCalled();
});

it("preserves a preexisting collision the exclusive open did not create", async () => {
  await writeFile(state.stagingPath, "another writer");
  await expect(decodeInProfileOf(path.join(dir, "in.png"), path.join(dir, "main.png"), path.join(dir, "out.png"), vi.fn()))
    .rejects.toMatchObject({ code: "fs.failed", details: { errno: "EEXIST" } });
  expect(await readFile(state.stagingPath, "utf8")).toBe("another writer");
});
