// `out`: the exact file a single-file verb writes, beside the folder-and-stem form,
// so a caller with a chosen path (a save dialog's) needs no copy or rename of its own.
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GptImg } from "../../src/index.ts";
import { done } from "../helpers/results.ts";

describe("an exact output path", () => {
  let tmp: string;
  let source: string;
  const img = new GptImg();

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-exact-out-"));
    source = path.join(tmp, "fox.png");
    await sharp({ create: { width: 20, height: 10, channels: 3, background: "#c06030" } }).png().toFile(source);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("writes exactly there, in a folder it creates, and replaces a file there only with overwrite", async () => {
    const target = path.join(tmp, "chosen", "Fox Export.JPG");
    expect(done(await img.encode({ in: source, out: target, format: "jpeg" })).output).toBe(target);
    expect((await sharp(target).metadata()).format).toBe("jpeg");
    expect(await img.encode({ in: source, out: target, format: "jpeg" })).toMatchObject({ status: "refused", refusal: { code: "output.exists" } });
    await writeFile(target, "older");
    expect(done(await img.resize({ in: source, out: target, format: "jpeg", toSize: 10, overwrite: true })).output).toBe(target);
    expect((await sharp(target).metadata()).width).toBe(10);
    expect(await readdir(path.dirname(target))).toEqual(["Fox Export.JPG"]);
  });

  it("refuses a relative path, a path with another format's extension, and one combined with outDir or outName", async () => {
    await expect(img.encode({ in: source, out: "fox.jpg", format: "jpeg" })).rejects.toMatchObject({ code: "args.invalid", details: { field: "out" } });
    await expect(img.encode({ in: source, out: path.join(tmp, "fox.png"), format: "jpeg" })).rejects.toMatchObject({
      code: "args.invalid",
      details: { field: "out" },
    });
    await expect(img.encode({ in: source, out: path.join(tmp, "a.webp"), outDir: tmp, format: "webp" })).rejects.toMatchObject({
      details: { field: "out", constraint: "not with outDir or outName" },
    });
  });

  it("chooses the destination of a verb with no input folder", async () => {
    const target = path.join(tmp, "plate.png");
    expect(done(await img.backplate({ out: target, size: 16, from: "#336699", to: "#ffcc00" })).output).toBe(target);
  });
});
