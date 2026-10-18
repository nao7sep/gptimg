import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeImageFile, writeMaskPNG, writeRGBA } from "../../src/image/bridge.ts";
import { captureExif, captureXmp, readCaptureMetadata } from "../../src/image/capture.ts";
import { readExifTags } from "../helpers/exif.ts";

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

interface TiffEntry {
  tag: number;
  type: number;
  count: number;
  value: number | string;
}

function tiff(entries: TiffEntry[], littleEndian = true): Buffer {
  const bytes = Buffer.alloc(8 + 2 + entries.length * 12 + 4);
  const u16 = (value: number, at: number): void => { littleEndian ? bytes.writeUInt16LE(value, at) : bytes.writeUInt16BE(value, at); };
  const u32 = (value: number, at: number): void => { littleEndian ? bytes.writeUInt32LE(value, at) : bytes.writeUInt32BE(value, at); };
  bytes.write(littleEndian ? "II" : "MM", 0, "latin1");
  u16(42, 2);
  u32(8, 4);
  u16(entries.length, 8);
  entries.forEach((entry, index) => {
    const at = 10 + index * 12;
    u16(entry.tag, at);
    u16(entry.type, at + 2);
    u32(entry.count, at + 4);
    if (typeof entry.value === "string") bytes.write(entry.value, at + 8, 4, "latin1");
    else u32(entry.value, at + 8);
  });
  return bytes;
}

const MODEL: TiffEntry = { tag: 0x0110, type: 2, count: 3, value: "M1\0" };

/** Refuse an unsafe allocation in the regression itself, before it can OOM. */
async function observeLargeArrays(body: () => void | Promise<void>): Promise<number[]> {
  const attempted: number[] = [];
  const from = Array.from;
  const spy = vi.spyOn(Array, "from").mockImplementation((...args) => {
    const length = (args[0] as { length?: number }).length;
    if (length !== undefined && length > 1_000_000) {
      attempted.push(length);
      throw new RangeError("Unsafe EXIF array request intercepted by test");
    }
    return Reflect.apply(from, Array, args);
  });
  try { await body(); } finally { spy.mockRestore(); }
  return attempted;
}

async function jpegWithExif(exif: Buffer): Promise<Buffer> {
  const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#336699" } }).jpeg().toBuffer();
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), exif]);
  const marker = Buffer.alloc(4);
  marker.writeUInt16BE(0xffe1);
  marker.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), marker, payload, jpeg.subarray(2)]);
}

describe("captureExif", () => {
  it.each([true, false])("reads a valid TIFF header in either byte order (little endian: %s)", (littleEndian) => {
    expect(captureExif(tiff([MODEL], littleEndian))).toEqual({ IFD0: { Model: "M1 ()" }, IFD2: { ColorSpace: "1 ()" } });
  });

  it.each([3, 4, 5, 10])("rejects an impossible type %s count before allocating from it", async (type) => {
    const malformed = tiff([{ tag: 0x010f, type, count: 1_000_000_000, value: 8 }]);
    const attempted = await observeLargeArrays(() => { expect(captureExif(malformed)).toBeUndefined(); });
    expect(attempted).toEqual([]);
  });

  it("does not decode array values for metadata outside the capture contract", () => {
    const metadata = Buffer.concat([tiff([MODEL, { tag: 0x0131, type: 3, count: 4, value: 38 }]), Buffer.alloc(8)]);
    const spy = vi.spyOn(Array, "from");
    try {
      expect(captureExif(metadata)).toEqual({ IFD0: { Model: "M1 ()" }, IFD2: { ColorSpace: "1 ()" } });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it.each([1, 2, 3, 4, 5, 10])("rejects an out-of-range supported type %s payload, including unretained tags", (type) => {
    const malformed = tiff([MODEL, { tag: 0x0131, type, count: 20, value: 37 }]);
    expect(captureExif(malformed)).toBeUndefined();
  });

  it.each(["byte order", "magic", "short header", "short entry table", "missing next IFD offset", "outside IFD offset", "outside payload offset"])(
    "holds no metadata for an invalid %s",
    (invalid) => {
      let malformed = tiff([MODEL], invalid !== "byte order");
      if (invalid === "byte order") malformed.write("XX", 0, "latin1");
      if (invalid === "magic") malformed.writeUInt16LE(43, 2);
      if (invalid === "short header") malformed = malformed.subarray(0, 7);
      if (invalid === "short entry table") malformed.writeUInt16LE(2, 8);
      if (invalid === "missing next IFD offset") malformed = malformed.subarray(0, malformed.length - 4);
      if (invalid === "outside IFD offset") malformed.writeUInt32LE(0xffffffff, 4);
      if (invalid === "outside payload offset") malformed = tiff([MODEL, { tag: 0x010f, type: 2, count: 5, value: 0xffffffff }]);
      expect(captureExif(malformed)).toBeUndefined();
    },
  );

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

  it("rejects malformed EXIF reached through a real image read and still writes its pixels", async () => {
    const malformed = tiff([{ tag: 0x010f, type: 3, count: 1_000_000_000, value: 8 }]);
    await writeFile(source, await jpegWithExif(malformed));
    const meta = await sharp(source).metadata();
    expect(meta.exif?.subarray(6)).toEqual(malformed);
    const out = path.join(tmp, "malformed-capture.png");
    const attempted = await observeLargeArrays(async () => {
      expect(await readCaptureMetadata(source)).toEqual({});
      await writeImageFile({ path: out, source }, "resize", { format: "png" }, () => sharp(source).resize(4, 4));
    });
    expect(attempted).toEqual([]);
    const written = await sharp(out).metadata();
    expect(written.width).toBe(4);
    expect(written.height).toBe(4);
    expect(written.exif).toBeUndefined();
  });
});
