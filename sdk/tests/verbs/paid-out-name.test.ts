// A paid verb's outName follows the local verbs' rule: a bare name lands in the
// output folder, an absolute stem also chooses the folder, and anything else is
// refused before the provider is called.
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GptImg } from "../../src/gptimg.ts";
import type { Provider } from "../../src/providers/types.ts";
import { done } from "../helpers/results.ts";

const provider = vi.hoisted(() => ({ generate: vi.fn(), edit: vi.fn(), vision: vi.fn(), chat: vi.fn() }));
vi.mock("../../src/providers/index.ts", () => ({
  getProvider: (): Provider => ({ name: "openai", ...provider }),
}));

describe("paid verbs' outName", () => {
  let tmp: string;
  let outDir: string;
  let input: string;
  let sdk: GptImg;

  beforeEach(async () => {
    for (const fn of Object.values(provider)) fn.mockReset();
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-paid-outname-"));
    outDir = path.join(tmp, "out");
    await mkdir(outDir);
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#336699" } }).png().toBuffer();
    input = path.join(tmp, "in.png");
    await sharp(png).toFile(input);
    provider.generate.mockResolvedValue({ raw: {}, images: [{ data: png }] });
    sdk = new GptImg({ apiKey: "sk-disposable-test" });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it.each(["../escape", "sub/x", "", ".", ".."])("refuses %j on generate, edit and vision before any provider call", async (outName) => {
    const invalid = { code: "args.invalid", details: { field: "outName" } };
    await expect(sdk.generate({ prompt: "x", outDir, outName })).rejects.toMatchObject(invalid);
    await expect(sdk.edit({ prompt: "x", in: input, outName })).rejects.toMatchObject(invalid);
    await expect(sdk.vision({ inputs: [input], check: "x", outName })).rejects.toMatchObject(invalid);
    expect(provider.generate).not.toHaveBeenCalled();
    expect(provider.edit).not.toHaveBeenCalled();
    expect(provider.vision).not.toHaveBeenCalled();
    expect(await readdir(tmp)).toEqual(["in.png", "out"]);
  });

  it("puts an absolute stem in its own folder, with no outDir needed", async () => {
    const elsewhere = path.join(tmp, "elsewhere");
    await mkdir(elsewhere);
    const result = done(await sdk.generate({ prompt: "x", outName: path.join(elsewhere, "picked") }));
    expect(result.files[0]!.path).toBe(path.join(elsewhere, "picked.png"));
    expect((await readdir(elsewhere)).sort()).toEqual(["picked.json", "picked.png"]);
    expect(await readdir(outDir)).toEqual([]);
  });
});
