import { lstatSync } from "node:fs";
import { done } from "../helpers/results.ts";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GptImg } from "../../src/gptimg.ts";
import type { Provider } from "../../src/providers/types.ts";

const generate = vi.hoisted(() => vi.fn());
vi.mock("../../src/providers/index.ts", () => ({
  getProvider: (): Provider => ({ name: "openai", generate, edit: vi.fn(), vision: vi.fn(), chat: vi.fn() }),
}));

const SPELLINGS = [
  ["cafe\u0301", "caf\u00e9"],
  ["caf\u00e9", "cafe\u0301"],
] as const;

function sameFile(existing: string, requested: string): boolean {
  const actual = lstatSync(existing);
  const alias = lstatSync(requested, { throwIfNoEntry: false });
  return alias?.dev === actual.dev && alias.ino === actual.ino;
}

describe("Unicode output names through public verbs", () => {
  let tmp: string;
  let outDir: string;
  let sdk: GptImg;
  let png: Buffer;

  beforeEach(async () => {
    generate.mockReset();
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-normalization-"));
    outDir = path.join(tmp, "out");
    await mkdir(outDir);
    sdk = new GptImg({ apiKey: "sk-disposable-test", modelsDir: path.join(tmp, "models"), logDir: path.join(tmp, "logs") });
    png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#336699" } }).png().toBuffer();
    generate.mockResolvedValue({ raw: {}, images: [{ data: png }] });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it.each(SPELLINGS)("rejects a normalized group collision before calling the provider (%s against %s)", async (existing, requested) => {
    const image = path.join(outDir, `${existing}-1.png`);
    await writeFile(image, "old image");
    await expect(sdk.generate({ prompt: "again", outDir, outName: requested, policy: { generate: { n: 2 } } }))
      .resolves.toMatchObject({ status: "refused", refusal: { code: "output.exists" } });
    expect(generate).not.toHaveBeenCalled();
    expect(await readFile(image, "utf8")).toBe("old image");
  });

  it.each(SPELLINGS.flatMap(([existing, requested]) => [[existing, requested, 1], [existing, requested, 2]] as const))(
    "preserves every protected slot before a provider call (%s against %s, %i outputs)",
    async (existing, requested, count) => {
      const slot = (stem: string, index: number): string => `${stem}${count === 1 ? "" : `-${index}`}`;
      for (let index = 1; index <= count; index++) {
        await writeFile(path.join(outDir, `${slot(existing, index)}.png`), `old image ${index}`);
        await writeFile(path.join(outDir, `${slot(existing, index)}.json`), JSON.stringify({ formatVersion: index === count ? 3 : 1, request: {}, files: [] }));
      }
      generate.mockResolvedValue({ raw: {}, images: Array.from({ length: count }, () => ({ data: png })) });
      const names = (await readdir(outDir)).sort();
      const before = await Promise.all(names.map((name) => readFile(path.join(outDir, name))));
      const alias = sameFile(path.join(outDir, `${slot(existing, 1)}.png`), path.join(outDir, `${slot(requested, 1)}.png`));
      const again = sdk.generate({ prompt: "again", outDir, outName: requested, overwrite: true, policy: { generate: { n: count } } });
      if (alias) await expect(again).rejects.toMatchObject({ code: "sidecar.newerFormat" });
      else await expect(again).resolves.toMatchObject({ status: "refused", refusal: { code: "output.normalizationConflict" } });
      expect(generate).not.toHaveBeenCalled();
      expect((await readdir(outDir)).sort()).toEqual(names);
      expect(await Promise.all(names.map((name) => readFile(path.join(outDir, name))))).toEqual(before);
    },
  );

  it.each(SPELLINGS)("overwrites an image in another format without leaving an equivalent Unicode sibling (%s against %s)", async (existing, requested) => {
    const oldImage = path.join(outDir, `${existing}.jpg`);
    await writeFile(oldImage, "old image");
    await writeFile(path.join(outDir, `${existing}.json`), "{}");
    const args = { prompt: "again", outDir, outName: requested, overwrite: true };
    if (sameFile(oldImage, path.join(outDir, `${requested}.jpg`))) {
      await expect(sdk.generate(args)).resolves.toMatchObject({ failures: [] });
    } else {
      await expect(sdk.generate(args)).resolves.toMatchObject({ status: "refused", refusal: { code: "output.normalizationConflict" } });
      expect(generate).not.toHaveBeenCalled();
      expect(await readFile(oldImage, "utf8")).toBe("old image");
      await expect(sdk.generate({ ...args, outName: existing })).resolves.toMatchObject({ failures: [] });
    }
    expect((await readdir(outDir)).map((name) => name.normalize("NFC")).sort())
      .toEqual([`${requested.normalize("NFC")}.json`, `${requested.normalize("NFC")}.png`]);
  });

  it.each(SPELLINGS)("keeps local overwrite portable with equivalent Unicode names (%s against %s)", async (existing, requested) => {
    const output = path.join(outDir, `${existing}.png`);
    await writeFile(output, "old image");
    const args = { size: 8, from: "#000000", to: "#ffffff", outDir, outName: requested };
    await expect(sdk.backplate(args)).resolves.toMatchObject({ status: "refused", refusal: { code: "output.exists" } });
    expect(await readFile(output, "utf8")).toBe("old image");
    if (sameFile(output, path.join(outDir, `${requested}.png`))) {
      const result = done(await sdk.backplate({ ...args, overwrite: true }));
      expect((await sharp(result.output).metadata()).width).toBe(8);
      expect(await readdir(outDir)).toHaveLength(1);
    } else {
      await expect(sdk.backplate({ ...args, overwrite: true })).resolves.toMatchObject({ status: "refused", refusal: { code: "output.normalizationConflict" } });
      expect(await readFile(output, "utf8")).toBe("old image");
      expect(await readdir(outDir)).toHaveLength(1);
      const result = done(await sdk.backplate({ ...args, outName: existing, overwrite: true }));
      expect((await sharp(result.output).metadata()).width).toBe(8);
    }
    await expect(sdk.backplate({ ...args, outName: requested.toUpperCase(), overwrite: true }))
      .resolves.toMatchObject({ status: "refused", refusal: { code: "output.caseConflict" } });
  });

  it.each(SPELLINGS)("replaces a dangling symlink under its equivalent Unicode alias (%s against %s)", async (existing, requested) => {
    const output = path.join(outDir, `${existing}.png`);
    const missing = path.join(tmp, "missing.png");
    await symlink(missing, output);
    const args = { size: 8, from: "#000000", to: "#ffffff", outDir, outName: requested, overwrite: true };
    if (sameFile(output, path.join(outDir, `${requested}.png`))) {
      const result = done(await sdk.backplate(args));
      expect(lstatSync(result.output).isSymbolicLink()).toBe(false);
      expect((await sharp(result.output).metadata()).width).toBe(8);
    } else {
      await expect(sdk.backplate(args)).resolves.toMatchObject({ status: "refused", refusal: { code: "output.normalizationConflict" } });
      expect(lstatSync(output).isSymbolicLink()).toBe(true);
    }
    expect(lstatSync(missing, { throwIfNoEntry: false })).toBeUndefined();
    expect(await readdir(outDir)).toHaveLength(1);
  });
});
