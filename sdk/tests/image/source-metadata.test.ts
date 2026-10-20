// A derived image keeps its main input's metadata unchanged, with its pixels in
// the input's orientation and colour profile so those tags stay true
// (sdk-conventions, *An artifact holds itself*). The regression this holds: a
// portrait phone photo is stored landscape with an Orientation tag, and an
// output that kept the pixels as stored but not the tag showed sideways.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp, { type Metadata } from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GptImg } from "../../src/index.ts";
import { writeMaskPNG, writeRGBA } from "../../src/image/bridge.ts";
import { embedSourceMetadata, readSourceMetadata, withoutPreview } from "../../src/image/source-metadata.ts";
import { done } from "../helpers/results.ts";
import { readExifTags } from "../helpers/exif.ts";

const XMP =
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
  `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="someone"/></rdf:RDF></x:xmpmeta>`;

let tmp: string;
let portrait: string;
let source: Metadata;
let storedPixel: Buffer;
const img = new GptImg();

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "gptimg-source-meta-"));
  portrait = path.join(tmp, "portrait.jpg");
  // Stored 96x64 landscape; Orientation 6 shows it as 64x96 portrait. The pixels are in Display P3.
  await sharp({ create: { width: 96, height: 64, channels: 3, background: { r: 200, g: 40, b: 30 } } })
    .withMetadata({ orientation: 6 })
    .withIccProfile("p3")
    .withExifMerge({ IFD0: { Make: "Phone", Model: "One" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "35/1 40/1 0/1" } })
    .withXmp(XMP)
    .jpeg({ quality: 95 })
    .toFile(portrait);
  source = await sharp(portrait).metadata();
  storedPixel = (await sharp(portrait).keepIccProfile().raw().toBuffer()).subarray(0, 3);
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function expectKept(output: string, size: { width: number; height: number }): Promise<void> {
  const meta = await sharp(output).metadata();
  expect(meta.orientation, "orientation").toBe(6);
  expect({ width: meta.width, height: meta.height }, "stored size").toEqual(size);
  expect(meta.icc?.equals(source.icc!), "colour profile").toBe(true);
  expect(meta.xmp?.toString("utf-8"), "xmp").toContain('dc:creator="someone"');
  const tags = readExifTags(meta.exif!);
  expect(tags.ifd0.get(0x010f), "make").toBe("Phone");
  expect(tags.gps.get(0x0002), "gps").toBe("35/1 40/1 0/1");
  // The pixels are still in the source's profile, not converted to sRGB.
  const pixel = (await sharp(output).keepIccProfile().raw().toBuffer()).subarray(0, 3);
  for (let c = 0; c < 3; c++) expect(Math.abs(pixel[c]! - storedPixel[c]!), `channel ${c}`).toBeLessThanOrEqual(3);
}

describe("a portrait phone photo through the local verbs", () => {
  it("resize keeps its orientation, profile and metadata", async () => {
    const out = done(await img.resize({ in: portrait, outName: "resized", toSize: 48 }));
    await expectKept(out.output, { width: 48, height: 32 });
  });

  it("encode keeps them", async () => {
    const out = done(await img.encode({ in: portrait, outName: "encoded", format: "png" }));
    await expectKept(out.output, { width: 96, height: 64 });
  });

  it("encode to webp keeps them", async () => {
    const out = done(await img.encode({ in: portrait, outName: "encoded-webp", format: "webp", lossless: true }));
    await expectKept(out.output, { width: 96, height: 64 });
  });

  it("compose, which works on decoded pixels, keeps them", async () => {
    const mask = path.join(tmp, "mask.png");
    await sharp({ create: { width: 96, height: 64, channels: 3, background: "#ffffff" } }).png().toFile(mask);
    const out = done(await img.compose({ in: portrait, mask, outName: "composed" }));
    await expectKept(out.output, { width: 96, height: 64 });
  });

  it("encode to jpeg keeps them", async () => {
    const out = done(await img.encode({ in: portrait, outName: "encoded-jpeg", format: "jpeg", quality: 95 }));
    await expectKept(out.output, { width: 96, height: 64 });
  });
});

describe("a secondary input in another profile", () => {
  // An sRGB picture with no profile beside the P3 photo: it must keep its colours, so its pixels
  // are converted into the photo's profile, which the output carries.
  const RED = { r: 200, g: 40, b: 30 };
  let srgb: string;
  let expectedInP3: Buffer;

  beforeAll(async () => {
    srgb = path.join(tmp, "srgb-red.png");
    await sharp({ create: { width: 96, height: 64, channels: 3, background: RED } }).png().toFile(srgb);
    expectedInP3 = (await sharp(srgb).withIccProfile("p3").raw().toBuffer()).subarray(0, 3);
  });

  async function expectRedKept(output: string, x: number, y: number): Promise<void> {
    const meta = await sharp(output).metadata();
    expect(meta.icc?.equals(source.icc!), "the photo's profile").toBe(true);
    expect(meta.orientation, "the photo's orientation").toBe(6);
    const at = (y * meta.width! + x) * meta.channels!;
    const stored = await sharp(output).keepIccProfile().raw().toBuffer();
    const seen = await sharp(output).toColourspace("srgb").raw().toBuffer();
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(stored[at + c]! - expectedInP3[c]!), `stored channel ${c}`).toBeLessThanOrEqual(2);
      expect(Math.abs(seen[at + c]! - [RED.r, RED.g, RED.b][c]!), `shown channel ${c}`).toBeLessThanOrEqual(3);
    }
  }

  it("compose converts its over-image into the input's profile", async () => {
    const clear = path.join(tmp, "clear-mask.png");
    await sharp({ create: { width: 96, height: 64, channels: 3, background: "#000000" } }).png().toFile(clear);
    const out = done(await img.compose({ in: portrait, mask: clear, over: srgb, outName: "over-srgb" }));
    await expectRedKept(out.output, 10, 10);
  });

  it("layer converts its top into the base's profile and keeps the base's metadata", async () => {
    const top = path.join(tmp, "srgb-top.png");
    await sharp({ create: { width: 16, height: 16, channels: 3, background: RED } }).png().toFile(top);
    const out = done(await img.layer({ base: portrait, top, outName: "layered", gravity: "center" }));
    await expectRedKept(out.output, 48, 32);
    expect(readExifTags((await sharp(out.output).metadata()).exif!).ifd0.get(0x010f)).toBe("Phone");
  });
});

/** A little-endian TIFF block: IFD0 with Make, then IFD1 pointing at a JPEG thumbnail. */
function tiffWithPreview(preview: Buffer): Buffer {
  const ifd0 = 8;
  const ifd1 = ifd0 + 2 + 12 + 4;
  const thumbAt = ifd1 + 2 + 2 * 12 + 4;
  const tiff = Buffer.alloc(thumbAt + preview.length);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(ifd0, 4);
  tiff.writeUInt16LE(1, ifd0);
  tiff.writeUInt16LE(0x010f, ifd0 + 2); // Make, ASCII "Ph\0"
  tiff.writeUInt16LE(2, ifd0 + 4);
  tiff.writeUInt32LE(3, ifd0 + 6);
  tiff.write("Ph\0", ifd0 + 10, "latin1");
  tiff.writeUInt32LE(ifd1, ifd0 + 14);
  tiff.writeUInt16LE(2, ifd1);
  for (const [i, [tag, value]] of [[0x0201, thumbAt], [0x0202, preview.length]].entries()) {
    const at = ifd1 + 2 + i * 12;
    tiff.writeUInt16LE(tag!, at);
    tiff.writeUInt16LE(4, at + 2);
    tiff.writeUInt32LE(1, at + 4);
    tiff.writeUInt32LE(value!, at + 8);
  }
  preview.copy(tiff, thumbAt);
  return tiff;
}

async function jpegWithExif(tiff: Buffer): Promise<Buffer> {
  const jpeg = await sharp({ create: { width: 16, height: 8, channels: 3, background: "#336699" } }).jpeg().toBuffer();
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const marker = Buffer.alloc(4);
  marker.writeUInt16BE(0xffe1);
  marker.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), marker, payload, jpeg.subarray(2)]);
}

describe("the source's metadata in a derived image", () => {
  const PREVIEW = Buffer.from("PREVIEW-OF-THE-IMAGE-BEFORE-THE-CHANGE");

  it("drops an embedded preview and keeps the rest of the EXIF block", () => {
    const kept = withoutPreview(tiffWithPreview(PREVIEW))!;
    expect(kept.includes(PREVIEW)).toBe(false);
    expect(kept.readUInt32LE(8 + 2 + 12)).toBe(0); // IFD0 no longer links to IFD1
    expect(readExifTags(kept).ifd0.get(0x010f)).toBe("Ph");
  });

  it("does not keep an EXIF block it cannot parse, and still writes the pixels", async () => {
    const broken = Buffer.from("II*\0\xff\xff\xff\x7f", "latin1");
    expect(withoutPreview(broken)).toBeUndefined();
    const source = path.join(tmp, "broken-exif.jpg");
    await writeFile(source, await jpegWithExif(broken));
    const out = path.join(tmp, "from-broken.png");
    await writeRGBA(new Uint8Array(16 * 8 * 4).fill(200), 16, 8, { path: out, source }, { format: "png" });
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([16, 8]);
    expect(meta.exif).toBeUndefined();
  });

  it("writes raw pixels with the source's EXIF but not its preview", async () => {
    const source = path.join(tmp, "with-preview.jpg");
    await writeFile(source, await jpegWithExif(tiffWithPreview(PREVIEW)));
    for (const format of ["png", "jpeg", "webp"] as const) {
      const out = path.join(tmp, `from-preview.${format}`);
      await writeRGBA(new Uint8Array(16 * 8 * 4).fill(255), 16, 8, { path: out, source }, { format });
      const meta = await sharp(out).metadata();
      expect(meta.exif, format).toBeDefined();
      expect(meta.exif!.includes(PREVIEW), format).toBe(false);
      expect(readExifTags(meta.exif!).ifd0.get(0x010f), format).toBe("Ph");
    }
  });

  it("keeps the source's orientation and EXIF in a mask", async () => {
    const mask = path.join(tmp, "portrait-mask.png");
    await writeMaskPNG(new Uint8Array(96 * 64).fill(255), 96, 64, { path: mask, source: portrait }, {});
    const meta = await sharp(mask).metadata();
    expect(meta.orientation).toBe(6);
    expect(readExifTags(meta.exif!).ifd0.get(0x010f)).toBe("Phone");
  });

  it("writes no RGB profile into a grey image, which cannot carry one", async () => {
    const icc = (await readSourceMetadata(portrait)).icc!;
    const grey = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#808080" } }).toColourspace("b-w").png().toBuffer();
    const greyJpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#808080" } }).toColourspace("b-w").jpeg().toBuffer();
    for (const bytes of [grey, greyJpeg]) {
      const meta = await sharp(embedSourceMetadata(bytes, { icc, xmp: Buffer.from(XMP) })).metadata();
      expect(meta.channels).toBe(1);
      expect(meta.icc).toBeUndefined();
      expect(meta.xmp).toBeDefined();
    }
  });

  it("adds nothing when the source holds no metadata", async () => {
    const plain = path.join(tmp, "plain.png");
    await sharp({ create: { width: 8, height: 8, channels: 4, background: "#fff" } }).png().toFile(plain);
    expect(await readSourceMetadata(plain)).toEqual({});
    const out = path.join(tmp, "from-plain.png");
    await writeRGBA(new Uint8Array(8 * 8 * 4), 8, 8, { path: out, source: plain }, { format: "png" });
    const meta = await sharp(out).metadata();
    expect([meta.exif, meta.xmp, meta.icc]).toEqual([undefined, undefined, undefined]);
  });

  it("does not keep a CMYK profile, whose pixels sharp converts to sRGB", async () => {
    const cmyk = path.join(tmp, "cmyk.jpg");
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#c02010" } }).withIccProfile("cmyk").jpeg().toFile(cmyk);
    expect((await readSourceMetadata(cmyk)).icc).toBeUndefined();
  });

  it("keeps the IPTC block in a JPEG", async () => {
    const record = Buffer.from([0x1c, 0x02, 0x78, 0x00, 0x05, ...Buffer.from("hello")]);
    const resource = Buffer.concat([Buffer.from("8BIM\x04\x04\0\0", "latin1"), Buffer.alloc(4), record]);
    resource.writeUInt32BE(record.length, 8);
    const iptc = Buffer.concat([Buffer.from("Photoshop 3.0\0", "latin1"), resource]);
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#808080" } }).jpeg().toBuffer();
    const embedded = embedSourceMetadata(jpeg, { iptc });
    expect((await sharp(embedded).metadata()).iptc?.equals(iptc)).toBe(true);
  });
});
