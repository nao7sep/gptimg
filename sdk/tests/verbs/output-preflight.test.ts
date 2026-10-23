import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GptImg } from "../../src/gptimg.ts";
import type { Provider } from "../../src/providers/types.ts";

const io = vi.hoisted(() => ({
  directory: "",
  sidecar: "",
  entered: undefined as (() => void) | undefined,
  held: undefined as Promise<void> | undefined,
}));
const generate = vi.hoisted(() => vi.fn());
vi.mock("../../src/providers/index.ts", () => ({
  getProvider: (): Provider => ({ name: "openai", generate, edit: vi.fn(), vision: vi.fn(), chat: vi.fn() }),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (args[0] === io.directory) {
        io.entered?.();
        await io.held;
      }
      return actual.readdir(...args);
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (args[0] === io.sidecar) {
        io.entered?.();
        await io.held;
      }
      return actual.readFile(...args);
    },
  };
});

describe("asynchronous output preflight", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-preflight-"));
    const png = await readFile(new URL("../fixtures/green-disk.png", import.meta.url));
    generate.mockReset().mockResolvedValue({ raw: {}, images: [{ data: png }] });
  });
  afterEach(async () => {
    io.directory = "";
    io.sidecar = "";
    io.entered = undefined;
    io.held = undefined;
    await rm(tmp, { recursive: true, force: true });
  });

  it.each(["directory", "sidecar"] as const)("keeps reservations and processes unrelated work and cancel while %s preflight waits", async (boundary) => {
    const blocked = path.join(tmp, "blocked");
    const other = path.join(tmp, "other");
    await mkdir(blocked);
    // A normal current-format sidecar drives the overwrite protection read.
    if (boundary === "sidecar") await writeFile(path.join(blocked, "same.json"), "{}");
    let release!: () => void;
    io.held = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { io.entered = resolve; });
    if (boundary === "directory") io.directory = blocked;
    else io.sidecar = path.join(blocked, "same.json");
    const sdk = new GptImg({ apiKey: "test-key" });
    const ctrl = new AbortController();
    const first = sdk.generate({ prompt: "first", outDir: blocked, outName: "same", overwrite: true }, { signal: ctrl.signal });
    // Attach the rejection handler while work is held, before aborting it.
    const cancelled = expect(first).rejects.toMatchObject({ code: "cancelled", effect: "none" });
    await entered;
    try {
      await expect(sdk.generate({ prompt: "collision", outDir: blocked, outName: "same" }))
        .resolves.toMatchObject({ status: "refused", refusal: { code: "output.busy" } });
      await expect(sdk.generate({ prompt: "unrelated", outDir: other, outName: "other" }))
        .resolves.toMatchObject({ status: "completed" });
      expect(generate).toHaveBeenCalledOnce();
      ctrl.abort();
      // Cancellation cannot release the claim while filesystem work is unsettled.
      await expect(sdk.generate({ prompt: "still busy", outDir: blocked, outName: "same" }))
        .resolves.toMatchObject({ status: "refused", refusal: { code: "output.busy" } });
    } finally {
      release();
    }
    await cancelled;
    expect(generate).toHaveBeenCalledOnce();
    await expect(sdk.generate({ prompt: "after settlement", outDir: blocked, outName: "same", overwrite: true }))
      .resolves.toMatchObject({ status: "completed" });
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
