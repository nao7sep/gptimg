import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import { runIcon } from "../../src/local/icon.ts";
import { decodeImage, encodeImage } from "../../src/image/bridge.ts";
import { readSourceMetadata } from "../../src/image/source-metadata.ts";

const decodes = vi.hoisted(() => ({ encodedMasters: 0 }));
vi.mock("../../src/image/bridge.ts", async (original) => {
  const real = await original<typeof import("../../src/image/bridge.ts")>();
  return { ...real, decodeImage: (...args: Parameters<typeof real.decodeImage>) => {
    if (Buffer.isBuffer(args[0])) decodes.encodedMasters++;
    return real.decodeImage(...args);
  } };
});
let tmp: string;
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });
it.each(["rgba", "p3", "grey", "cmyk", "density-only"])("reuses the prepared master safely and keeps rendition pixels and metadata (%s)", async (kind) => {
  tmp = await mkdtemp(path.join(tmpdir(), "gptimg-icon-master-"));
  const input = path.join(tmp, kind === "cmyk" ? "master.jpg" : "master.png");
  const pixels = Buffer.alloc(1024 * 1024 * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = i < pixels.length / 2 ? 220 : 30; pixels[i + 1] = 90;
    pixels[i + 2] = (i % 4096) < 2048 ? 60 : 180; pixels[i + 3] = i % 4096 < 2048 ? 255 : 128;
  }
  let pipeline = sharp(pixels, { raw: { width: 1024, height: 1024, channels: 4 } });
  if (kind === "p3") pipeline = pipeline.withIccProfile("p3").withMetadata({ density: 144, orientation: 6 });
  if (kind === "grey") pipeline = pipeline.toColourspace("b-w");
  if (kind === "cmyk") await pipeline.flatten({ background: "white" }).withIccProfile("cmyk").jpeg().toFile(input);
  else if (kind === "density-only") {
    const png = await pipeline.withDensity(144).png().toBuffer();
    // Keep pHYs while removing the EXIF sharp's density setter adds: this is
    // a valid source with container density and no authored EXIF.
    const chunks = [png.subarray(0, 8)];
    for (let at = 8; at < png.length;) {
      const end = at + 12 + png.readUInt32BE(at);
      if (png.toString("ascii", at + 4, at + 8) !== "eXIf") chunks.push(png.subarray(at, end));
      at = end;
    }
    await writeFile(input, Buffer.concat(chunks));
  } else await pipeline.png().toFile(input);
  decodes.encodedMasters = 0;
  const result = await runIcon({ in: input, outDir: tmp, name: "rendered", pngs: true });
  // Converted profiles and density without EXIF retain their old encoded
  // representation; ordinary icon masters reuse decoded pixels.
  expect(decodes.encodedMasters).toBe(["cmyk", "density-only"].includes(kind) ? 17 : 0);
  const source = await readSourceMetadata(input);
  const previousMaster = await decodeImage(input).ensureAlpha().png().toBuffer();
  for (const { size, path: output } of result.pngSet) {
    const expected = await encodeImage(decodeImage(previousMaster).resize(size, size, { fit: "fill", kernel: "lanczos3" }), {}, "icon", source);
    expect((await readFile(output)).equals(expected), `rendition ${size}`).toBe(true);
  }
  if (kind === "density-only") {
    const metadata = await sharp(result.png).metadata();
    expect(metadata.density).toBe(144);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
  }
  if (kind === "p3") {
    const meta = await sharp(result.png).metadata();
    expect(meta.orientation).toBe(6);
    expect(meta.density).toBe(144);
    expect(meta.icc).toEqual((await sharp(input).metadata()).icc);
  }
});
