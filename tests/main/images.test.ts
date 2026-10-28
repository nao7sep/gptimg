import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageAccess } from "../../src/main/images.ts";

vi.mock("electron", () => ({ net: { fetch: vi.fn() }, protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() } }));
const folders: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const root = () => {
  const folder = mkdtempSync(join(tmpdir(), "gptimg-images-"));
  folders.push(folder);
  return folder;
};
async function image(dir: string, name = "image.png", color = "#fff"): Promise<string> {
  const path = join(dir, name);
  await sharp({ create: { width: 64, height: 32, channels: 4, background: color } }).png().toFile(path);
  return path;
}

describe("image access", () => {
  it("allows protected files and explicit picks", async () => {
    const dir = root();
    const outside = root();
    const own = await image(dir);
    const other = await image(outside);
    const access = new ImageAccess(() => [dir, join(dir, "missing-root")]);
    expect(access.allowed(own)).toBe(true);
    expect(access.allowed(other)).toBe(false);
    expect(await access.png(other)).toBeNull();
    expect(await access.register(other)).toBe(true);
    expect(access.allowed(other)).toBe(true);
    const text = join(outside, "text.txt");
    writeFileSync(text, "text");
    expect(await access.register(text)).toBe(false);
  });

  it("resizes with orientation and alpha intact, without enlarging or exceeding the thumbnail bound", async () => {
    const dir = root();
    const path = join(dir, "oriented.png");
    await sharp({ create: { width: 80, height: 40, channels: 4, background: { r: 250, g: 0, b: 0, alpha: 0.5 } } })
      .withMetadata({ orientation: 6 }).png().toFile(path);
    const access = new ImageAccess(() => [dir]);
    const thumb = await access.png(path, 20);
    expect(thumb).not.toBeNull();
    const meta = await sharp(thumb!).metadata();
    expect(meta).toMatchObject({ width: 20, height: 40, hasAlpha: true, format: "png" });
    expect(meta.orientation).toBeUndefined();
    const pixel = await sharp(thumb!).raw().toBuffer();
    expect(pixel[3]).toBeGreaterThanOrEqual(127);
    expect(pixel[3]).toBeLessThanOrEqual(128);
    expect(await sharp((await access.png(path, 100))!).metadata()).toMatchObject({ width: 40, height: 80 });
    const large = join(dir, "large.png");
    await sharp({ create: { width: 4096, height: 64, channels: 3, background: "#369" } }).png().toFile(large);
    expect(await sharp((await access.png(large, 9000))!).metadata()).toMatchObject({ width: 2048, height: 32 });
    expect(await sharp((await access.png(large))!).metadata()).toMatchObject({ width: 4096, height: 64 });
  });

  it("returns null for unreadable image bytes and invalid thumbnail requests", async () => {
    const dir = root();
    const path = join(dir, "broken.png");
    writeFileSync(path, "broken");
    const access = new ImageAccess(() => [dir]);
    expect(await access.png(path)).toBeNull();
    expect(await access.png(path, NaN)).toBeNull();
    expect(await access.png(path, 0)).toBeNull();
  });

  it("encodes three images at a time, starts the rest as each finishes, and a later repeat finds the cached copy", async () => {
    const dir = root();
    const files = await Promise.all(["a", "b", "c", "d", "e"].map((name) => image(dir, `${name}.png`)));
    const access = new ImageAccess(() => [dir]);
    const release: Array<() => void> = [];
    let started = 0;
    let reached: { count: number; resolve: () => void } | undefined;
    const startedCount = (count: number) => started >= count ? Promise.resolve() : new Promise<void>((resolve) => { reached = { count, resolve }; });
    let active = 0;
    let peak = 0;
    const encoded = vi.spyOn(sharp.prototype, "toBuffer").mockImplementation(() => {
      active++;
      started++;
      peak = Math.max(peak, active);
      if (reached && started >= reached.count) reached.resolve();
      return new Promise<Buffer>((resolve) => release.push(() => {
        active--;
        resolve(Buffer.from("png"));
      })) as never;
    });
    const jobs = files.map((file) => access.png(file, 32));
    await startedCount(3);
    expect(active).toBe(3);
    release.shift()!();
    await startedCount(4);
    release.shift()!();
    await startedCount(5);
    while (release.length > 0) release.shift()!();
    await Promise.all(jobs);
    expect(peak).toBe(3);
    expect(await access.png(files[0]!, 32)).toEqual(Buffer.from("png"));
    expect(encoded).toHaveBeenCalledTimes(5);
  });

  it("caches thumbnails and leaves full PNG conversions uncached", async () => {
    const dir = root();
    const file = await image(dir);
    const access = new ImageAccess(() => [dir]);
    const encoded = vi.spyOn(sharp.prototype, "toBuffer").mockResolvedValue(Buffer.alloc(8) as never);
    await access.png(file, 32);
    await access.png(file, 32);
    expect(encoded).toHaveBeenCalledTimes(1);
    await access.png(file);
    await access.png(file);
    expect(encoded).toHaveBeenCalledTimes(3);
  });
});
