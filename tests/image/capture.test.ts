import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeImageFile, writeMaskPNG, writeRGBA } from "../../src/image/bridge.js";
import { captureExif, captureXmp } from "../../src/image/capture.js";
import { readExifTags } from "../helpers/exif.js";

const XMP =
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
  `<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:tiff="http://ns.adobe.com/tiff/1.0/"` +
  ` xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/" xmp:CreateDate="2019-05-06T07:08:09" xmp:ModifyDate="2001-01-01T00:00:00"` +
  ` tiff:ImageWidth="64" xmpMM:InstanceID="xmp.iid:source"><tiff:Model>EOS &amp; Co</tiff:Model></rdf:Description>` +
  `</rdf:RDF></x:xmpmeta>`;

/** A photo-like source with capture facts beside facts that describe the source file. */
async function photo(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: "#336699" } })
    .withExif({
      IFD0: { Make: "Canon Inc. (JP) ()", Model: "M1", DateTime: "2001:01:01 00:00:00", Software: "Editor" },
      IFD2: { DateTimeOriginal: "2019:05:06 07:08:09", OffsetTimeOriginal: "+09:00", ExposureTime: "1/125" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "35/1 40/1 3000/100", GPSAltitude: "100/1" },
    })
    .withXmp(XMP)
    .jpeg()
    .toBuffer();
}

describe("captureExif", () => {
  it("keeps the capture tags and nothing that describes the source file", async () => {
    const { exif } = await sharp(await photo()).metadata();
    expect(captureExif(exif!)).toEqual({
      IFD0: { Make: "Canon Inc. (JP) ()", Model: "M1 ()" },
      IFD2: { ExposureTime: "1/125 ()", DateTimeOriginal: "2019:05:06 07:08:09 ()", OffsetTimeOriginal: "+09:00 ()", ColorSpace: "1 ()" },
      IFD3: { GPSLatitudeRef: "N ()", GPSLatitude: "35/1 40/1 3000/100 ()", GPSAltitude: "100/1 ()" },
    });
  });

  it("holds nothing for a block without capture tags or one it cannot parse", async () => {
    const { exif } = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#000" } })
      .withExif({ IFD0: { Software: "Editor" } })
      .jpeg()
      .toBuffer()
      .then((b) => sharp(b).metadata());
    expect(captureExif(exif!)).toBeUndefined();
    expect(captureExif(Buffer.from("Exif\0\0II*\0\xff\xff\xff\x7f", "latin1"))).toBeUndefined();
  });
});

describe("captureXmp", () => {
  it("keeps the capture properties in attribute and element form", () => {
    const packet = captureXmp(XMP)!;
    expect(packet).toContain(`xmp:CreateDate="2019-05-06T07:08:09"`);
    expect(packet).toContain(`tiff:Model="EOS &amp; Co"`);
    expect(packet).not.toContain("ModifyDate");
    expect(packet).not.toContain("ImageWidth");
    expect(packet).not.toContain("InstanceID");
  });

  it("holds nothing for a packet without capture properties", () => {
    expect(captureXmp(`<x:xmpmeta xmlns:x="adobe:ns:meta/"/>`)).toBeUndefined();
  });
});

describe("derived images keep their source's capture facts", () => {
  let tmp: string;
  let source: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-capture-"));
    source = path.join(tmp, "photo.jpg");
    await writeFile(source, await photo());
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function expectCaptureFacts(file: string, width: number, height: number): Promise<void> {
    const meta = await sharp(file).metadata();
    const tags = readExifTags(meta.exif!);
    expect(tags.ifd0.get(0x010f)).toBe("Canon Inc. (JP)");
    expect(tags.ifd0.has(0x0132)).toBe(false); // the source's DateTime
    expect(tags.ifd0.has(0x0131)).toBe(false); // Software
    expect(tags.exif.get(0x9003)).toBe("2019:05:06 07:08:09");
    expect(tags.exif.get(0xa001)).toBe("1"); // sRGB, as encoded
    expect(tags.exif.get(0xa002)).toBe(String(width));
    expect(tags.exif.get(0xa003)).toBe(String(height));
    expect(tags.gps.get(0x0002)).toBe("35/1 40/1 3000/100");
    const xmp = meta.xmp!.toString("utf-8");
    expect(xmp).toContain("2019-05-06T07:08:09");
    expect(xmp).not.toContain("ModifyDate");
  }

  it("through a pipeline from the source, encoded opaque through its intermediate", async () => {
    const out = path.join(tmp, "resized.webp");
    await writeImageFile({ path: out, source }, "resize", { format: "webp", opaque: true }, () =>
      sharp(source).resize(32, 24),
    );
    await expectCaptureFacts(out, 32, 24);
  });

  it("through raw pixels and a mask", async () => {
    const rgba = path.join(tmp, "despeckled.png");
    await writeRGBA(new Uint8Array(16 * 8 * 4).fill(200), 16, 8, { path: rgba, source }, { format: "png" });
    await expectCaptureFacts(rgba, 16, 8);

    const mask = path.join(tmp, "mask.png");
    await writeMaskPNG(new Uint8Array(16 * 8).fill(255), 16, 8, { path: mask, source }, {});
    await expectCaptureFacts(mask, 16, 8);
  });

  it("adds no metadata when the source holds no capture facts", async () => {
    const plain = path.join(tmp, "plain.png");
    await sharp({ create: { width: 8, height: 8, channels: 4, background: "#fff" } }).png().toFile(plain);
    const out = path.join(tmp, "out.png");
    await writeRGBA(new Uint8Array(8 * 8 * 4), 8, 8, { path: out, source: plain }, { format: "png" });
    const meta = await sharp(out).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
  });
});
