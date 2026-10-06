import sharp, { type Sharp } from "sharp";

/**
 * The capture facts of a source image that a derived output keeps: when and
 * where it was taken and with what camera (content-lifecycle-conventions, *A
 * derived file is new*). Everything else in the source's metadata describes
 * the source file, so the output's dimensions, colour space and dates are its
 * own. A fact the source does not hold stays absent.
 */
export interface CaptureMetadata {
  /** EXIF tags in sharp's `withExif` shape, as libvips field strings. */
  exif?: Record<string, Record<string, string>>;
  /** A minimal XMP packet holding the source's capture properties. */
  xmp?: string;
}

// The capture tags kept, by sharp's IFD key: IFD0, the Exif IFD (IFD2) and the
// GPS IFD (IFD3). libvips cannot write a BYTE tag from a string, so
// GPSAltitudeRef is not among them and GPSAltitude is kept only when that ref
// is absent or 0 (above sea level), which absence also means.
const EXIF_CAPTURE_TAGS: Record<string, Record<number, string>> = {
  IFD0: { 0x010f: "Make", 0x0110: "Model" },
  IFD2: {
    0x829a: "ExposureTime",
    0x829d: "FNumber",
    0x8827: "ISOSpeedRatings",
    0x9003: "DateTimeOriginal",
    0x9004: "DateTimeDigitized",
    0x9011: "OffsetTimeOriginal",
    0x9012: "OffsetTimeDigitized",
    0x920a: "FocalLength",
    0x9291: "SubSecTimeOriginal",
    0x9292: "SubSecTimeDigitized",
    0xa433: "LensMake",
    0xa434: "LensModel",
  },
  IFD3: {
    0x0001: "GPSLatitudeRef",
    0x0002: "GPSLatitude",
    0x0003: "GPSLongitudeRef",
    0x0004: "GPSLongitude",
    0x0006: "GPSAltitude",
    0x0007: "GPSTimeStamp",
    0x0010: "GPSImgDirectionRef",
    0x0011: "GPSImgDirection",
    0x0012: "GPSMapDatum",
    0x001d: "GPSDateStamp",
  },
};

const EXIF_IFD_POINTER = 0x8769;
const GPS_IFD_POINTER = 0x8825;
const GPS_ALTITUDE_REF = 0x0005;
const GPS_ALTITUDE = 0x0006;

interface ExifEntry {
  type: number;
  values: string[];
}

/** Read one TIFF IFD's entries as strings; only the types capture tags use. */
function readIfd(tiff: Buffer, offset: number, le: boolean): Map<number, ExifEntry> {
  const u16 = (o: number): number => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number): number => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const sizes: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 10: 8 };
  const entries = new Map<number, ExifEntry>();
  const count = u16(offset);
  for (let i = 0; i < count; i++) {
    const at = offset + 2 + i * 12;
    const tag = u16(at);
    const type = u16(at + 2);
    const n = u32(at + 4);
    const size = sizes[type];
    if (size === undefined) continue;
    const start = size * n <= 4 ? at + 8 : u32(at + 8);
    let values: string[];
    if (type === 2) {
      values = [tiff.toString("utf-8", start, start + n).replace(/\0+$/, "")];
    } else if (type === 1) {
      values = Array.from(tiff.subarray(start, start + n), String);
    } else if (type === 3) {
      values = Array.from({ length: n }, (_, k) => String(u16(start + 2 * k)));
    } else if (type === 4) {
      values = Array.from({ length: n }, (_, k) => String(u32(start + 4 * k)));
    } else {
      const s32 = (o: number): number => (le ? tiff.readInt32LE(o) : tiff.readInt32BE(o));
      const read = type === 10 ? s32 : u32;
      values = Array.from({ length: n }, (_, k) => `${read(start + 8 * k)}/${read(start + 8 * k + 4)}`);
    }
    entries.set(tag, { type, values });
  }
  return entries;
}

/**
 * The capture tags of an EXIF block, as sharp `withExif` fields, or undefined
 * when it holds none. A block that cannot be parsed holds none.
 */
export function captureExif(exif: Buffer): CaptureMetadata["exif"] {
  const tiff = exif.subarray(0, 6).toString("latin1") === "Exif\0\0" ? exif.subarray(6) : exif;
  let ifds: Record<string, Map<number, ExifEntry>>;
  try {
    const le = tiff.toString("latin1", 0, 2) === "II";
    const ifd0 = readIfd(tiff, le ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4), le);
    const pointer = (tag: number): Map<number, ExifEntry> => {
      const at = ifd0.get(tag)?.values[0];
      return at === undefined ? new Map() : readIfd(tiff, Number(at), le);
    };
    ifds = { IFD0: ifd0, IFD2: pointer(EXIF_IFD_POINTER), IFD3: pointer(GPS_IFD_POINTER) };
  } catch {
    return undefined;
  }
  const altitudeRef = ifds.IFD3!.get(GPS_ALTITUDE_REF)?.values[0];
  if (altitudeRef !== undefined && altitudeRef !== "0") ifds.IFD3!.delete(GPS_ALTITUDE);

  const out: Record<string, Record<string, string>> = {};
  let found = false;
  for (const [ifd, tags] of Object.entries(EXIF_CAPTURE_TAGS)) {
    for (const [tag, name] of Object.entries(tags)) {
      const entry = ifds[ifd]!.get(Number(tag));
      if (!entry || entry.type === 1 || entry.values.length === 0) continue;
      // libvips reads a field as `value (description)` and drops the
      // parenthesised part, so an empty one keeps a value with its own
      // parentheses whole.
      (out[ifd] ??= {})[name] = `${entry.values.join(" ")} ()`;
      found = true;
    }
  }
  if (!found) return undefined;
  // The output is encoded in sRGB, sharp's default, whatever the source held.
  (out.IFD2 ??= {}).ColorSpace = "1 ()";
  return out;
}

const XMP_NAMESPACES: Record<string, string> = {
  exif: "http://ns.adobe.com/exif/1.0/",
  exifEX: "http://cipa.jp/exif/1.0/",
  photoshop: "http://ns.adobe.com/photoshop/1.0/",
  tiff: "http://ns.adobe.com/tiff/1.0/",
  xmp: "http://ns.adobe.com/xap/1.0/",
};

const XMP_CAPTURE_PROPERTIES = [
  "xmp:CreateDate",
  "photoshop:DateCreated",
  "exif:DateTimeOriginal",
  "exif:DateTimeDigitized",
  "exif:GPSLatitude",
  "exif:GPSLongitude",
  "exif:GPSAltitudeRef",
  "exif:GPSAltitude",
  "exif:GPSTimeStamp",
  "exif:GPSImgDirectionRef",
  "exif:GPSImgDirection",
  "exif:GPSMapDatum",
  "exif:ExposureTime",
  "exif:FNumber",
  "exif:FocalLength",
  "tiff:Make",
  "tiff:Model",
  "exifEX:LensMake",
  "exifEX:LensModel",
];

/**
 * A minimal XMP packet holding the simple-valued capture properties of a
 * source packet, by their conventional prefixes, or undefined when it holds
 * none. Values are kept as the source escaped them.
 */
export function captureXmp(xmp: string): string | undefined {
  const kept: string[] = [];
  const prefixes = new Set<string>();
  for (const name of XMP_CAPTURE_PROPERTIES) {
    const escaped = name.replace(":", "\\:");
    const match =
      new RegExp(`\\s${escaped}\\s*=\\s*"([^"]*)"`).exec(xmp) ??
      new RegExp(`\\s${escaped}\\s*=\\s*'([^']*)'`).exec(xmp) ??
      new RegExp(`<${escaped}>([^<]*)</${escaped}>`).exec(xmp);
    if (!match) continue;
    kept.push(`${name}="${match[1]!.replace(/"/g, "&quot;")}"`);
    prefixes.add(name.slice(0, name.indexOf(":")));
  }
  if (kept.length === 0) return undefined;
  const namespaces = [...prefixes].map((prefix) => `xmlns:${prefix}="${XMP_NAMESPACES[prefix]}"`);
  return (
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" ${[...namespaces, ...kept].join(" ")}/></rdf:RDF></x:xmpmeta>`
  );
}

/** The capture facts of the image at `path`. */
export async function readCaptureMetadata(path: string): Promise<CaptureMetadata> {
  const { exif, xmp } = await sharp(path).metadata();
  const capture: CaptureMetadata = {};
  const exifFields = exif ? captureExif(exif) : undefined;
  const xmpPacket = xmp ? captureXmp(xmp.toString("utf-8")) : undefined;
  if (exifFields) capture.exif = exifFields;
  if (xmpPacket) capture.xmp = xmpPacket;
  return capture;
}

/** Write `capture` into the image `image` encodes. */
export function withCaptureMetadata(image: Sharp, capture: CaptureMetadata): Sharp {
  if (capture.exif) image.withExif(capture.exif);
  if (capture.xmp) image.withXmp(capture.xmp);
  return image;
}
