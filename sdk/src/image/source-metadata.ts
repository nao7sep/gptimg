import { crc32, deflateSync } from "node:zlib";
import sharp from "./sharp.ts";

/**
 * A derived image keeps all of its main input's metadata unchanged
 * (sdk-conventions, *An artifact holds itself*): EXIF, the colour profile, XMP
 * and IPTC, as the input's own bytes. Its pixels stay in the input's
 * orientation and colour profile, so the Orientation tag and the profile stay
 * true; nothing is rotated or converted to sRGB. The one thing dropped is an
 * embedded EXIF preview, which would show the image before the change.
 *
 * sharp writes metadata only from fields it can express as strings, which
 * loses types and whole tags, and only from the image it decoded, which a verb
 * that works on raw pixels no longer has. So the blocks are written into the
 * encoded file directly, in each format's own container.
 */
export interface SourceMetadata {
  /** The EXIF block as a TIFF structure, its preview removed. */
  exif?: Buffer;
  /** The ICC profile, kept only when the pixels stay in it (an RGB or grey profile). */
  icc?: Buffer;
  /** The XMP packet. */
  xmp?: Buffer;
  /** The IPTC block as a JPEG APP13 payload ("Photoshop 3.0" resources). */
  iptc?: Buffer;
}

/** The colour space an ICC profile describes ('RGB ', 'GRAY', 'CMYK', ...), from its header. */
function profileSpace(icc: Buffer): string | null {
  return icc.length >= 20 ? icc.toString("latin1", 16, 20) : null;
}

/**
 * The metadata a derived image of the file at `path` keeps. A profile other
 * than RGB or grey is not kept: sharp converts such pixels (CMYK) to sRGB when
 * it decodes them, so the profile would no longer describe them.
 */
export async function readSourceMetadata(path: string): Promise<SourceMetadata> {
  const { exif, icc, xmp, iptc } = await sharp(path).metadata();
  const kept: SourceMetadata = {};
  if (exif && exif.length > 0) {
    const tiff = withoutPreview(exif.subarray(0, 6).toString("latin1") === "Exif\0\0" ? exif.subarray(6) : exif);
    if (tiff) kept.exif = tiff;
  }
  if (icc && ["RGB ", "GRAY"].includes(profileSpace(icc) ?? "")) kept.icc = Buffer.from(icc);
  if (xmp && xmp.length > 0) kept.xmp = Buffer.from(xmp);
  if (iptc && iptc.length > 0) kept.iptc = Buffer.from(iptc);
  return kept;
}

/**
 * A copy of a TIFF block without its preview: IFD0's link to the next IFD
 * (IFD1, the thumbnail's) is cut and the thumbnail's bytes and table are
 * zeroed, so no preview of the earlier image survives in the file. A block
 * that does not parse is not kept (undefined): it cannot be trusted to hold no
 * preview.
 */
export function withoutPreview(source: Buffer): Buffer | undefined {
  const tiff = Buffer.from(source);
  try {
    const order = tiff.toString("latin1", 0, 2);
    if (order !== "II" && order !== "MM") return undefined;
    const le = order === "II";
    const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
    const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
    if (u16(2) !== 42) return undefined;
    const ifd0 = u32(4);
    const nextAt = ifd0 + 2 + u16(ifd0) * 12;
    const ifd1 = u32(nextAt);
    if (ifd1 === 0) return tiff;
    const zero = (start: number, length: number) => {
      if (start >= 8 && length > 0 && start + length <= tiff.length) tiff.fill(0, start, start + length);
    };
    const count = u16(ifd1);
    const tags = new Map<number, number[]>();
    for (let i = 0; i < count; i++) {
      const at = ifd1 + 2 + i * 12;
      const type = u16(at + 2);
      const n = u32(at + 4);
      const size = type === 3 ? 2 : type === 4 ? 4 : 0;
      if (size === 0 || n === 0) continue;
      const start = size * n <= 4 ? at + 8 : u32(at + 8);
      tags.set(u16(at), Array.from({ length: Math.min(n, 4096) }, (_, k) => (size === 2 ? u16(start + 2 * k) : u32(start + 4 * k))));
    }
    // A JPEG thumbnail (offset 0x0201, length 0x0202) or an uncompressed one (strips 0x0111, 0x0117).
    const jpegAt = tags.get(0x0201)?.[0];
    const jpegLength = tags.get(0x0202)?.[0];
    if (jpegAt !== undefined && jpegLength !== undefined) zero(jpegAt, jpegLength);
    const strips = tags.get(0x0111) ?? [];
    const stripLengths = tags.get(0x0117) ?? [];
    strips.forEach((at, k) => zero(at, stripLengths[k] ?? 0));
    zero(ifd1, 2 + count * 12 + 4);
    if (le) tiff.writeUInt32LE(0, nextAt);
    else tiff.writeUInt32BE(0, nextAt);
    return tiff;
  } catch {
    return undefined;
  }
}

/** Whether `meta` holds anything to write. */
function holdsAny(meta: SourceMetadata): boolean {
  return meta.exif !== undefined || meta.icc !== undefined || meta.xmp !== undefined || meta.iptc !== undefined;
}

/**
 * The encoded image `bytes` (PNG, JPEG or WebP, as the encoder wrote them)
 * with `meta` in place of whatever metadata the encoder put there. A block the
 * format cannot hold is left out: IPTC in PNG and WebP, which have no place
 * for it, and in JPEG any block beyond a segment's 64 KB (a profile is split
 * over segments as the ICC specifies). A profile is written only when it
 * matches the image's colour model, so a grey mask never carries an RGB one.
 */
export function embedSourceMetadata(bytes: Buffer, meta: SourceMetadata): Buffer {
  if (!holdsAny(meta)) return bytes;
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return embedPng(bytes, meta);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return embedJpeg(bytes, meta);
  if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return embedWebp(bytes, meta);
  return bytes;
}

// ----- PNG -----

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const XMP_KEYWORD = "XML:com.adobe.xmp";

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0);
  return Buffer.concat([head, data, crc]);
}

function embedPng(bytes: Buffer, meta: SourceMetadata): Buffer {
  const chunks: Array<{ type: string; raw: Buffer; data: Buffer }> = [];
  for (let at = 8; at + 12 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    chunks.push({ type, raw: bytes.subarray(at, at + 12 + length), data: bytes.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  const ihdr = chunks.find((chunk) => chunk.type === "IHDR");
  if (!ihdr) return bytes;
  const grey = [0, 4].includes(ihdr.data[9]!);
  const replaced = (chunk: { type: string; data: Buffer }) =>
    ["iCCP", "sRGB", "gAMA", "cHRM", "eXIf"].includes(chunk.type) ||
    (["iTXt", "tEXt", "zTXt"].includes(chunk.type) && chunk.data.toString("latin1", 0, XMP_KEYWORD.length + 1) === `${XMP_KEYWORD}\0`);
  const added: Buffer[] = [];
  if (meta.icc && profileSpace(meta.icc) === (grey ? "GRAY" : "RGB ")) {
    added.push(pngChunk("iCCP", Buffer.concat([Buffer.from("icc\0\0", "latin1"), deflateSync(meta.icc)])));
  }
  if (meta.exif) added.push(pngChunk("eXIf", meta.exif));
  if (meta.xmp) added.push(pngChunk("iTXt", Buffer.concat([Buffer.from(`${XMP_KEYWORD}\0\0\0\0\0`, "latin1"), meta.xmp])));
  const out: Buffer[] = [PNG_SIGNATURE];
  for (const chunk of chunks) {
    if (replaced(chunk)) continue;
    out.push(chunk.raw);
    if (chunk.type === "IHDR") out.push(...added);
  }
  return Buffer.concat(out);
}

// ----- JPEG -----

const EXIF_HEADER = Buffer.from("Exif\0\0", "latin1");
const XMP_HEADER = Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1");
const ICC_HEADER = Buffer.from("ICC_PROFILE\0", "latin1");
const PHOTOSHOP_HEADER = Buffer.from("Photoshop 3.0\0", "latin1");
const MAX_SEGMENT = 65533;

function jpegSegment(marker: number, payload: Buffer): Buffer | null {
  if (payload.length > MAX_SEGMENT) return null;
  const head = Buffer.alloc(4);
  head.writeUInt16BE(marker, 0);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

function embedJpeg(bytes: Buffer, meta: SourceMetadata): Buffer {
  // The segments before the scan; markers without a length (RSTn, TEM) do not occur there.
  const kept: Buffer[] = [];
  let components = 3;
  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes.readUInt16BE(at);
    if (marker === 0xffda) break;
    const end = at + 2 + bytes.readUInt16BE(at + 2);
    const payload = bytes.subarray(at + 4, end);
    const startsWith = (header: Buffer) => payload.subarray(0, header.length).equals(header);
    const metadata =
      (marker === 0xffe1 && (startsWith(EXIF_HEADER) || startsWith(XMP_HEADER))) ||
      (marker === 0xffe2 && startsWith(ICC_HEADER)) ||
      (marker === 0xffed && startsWith(PHOTOSHOP_HEADER));
    if (marker >= 0xffc0 && marker <= 0xffcf && ![0xffc4, 0xffc8, 0xffcc].includes(marker)) components = payload[5] ?? 3;
    if (!metadata) kept.push(bytes.subarray(at, end));
    at = end;
  }
  const added: Buffer[] = [];
  const push = (segment: Buffer | null) => {
    if (segment) added.push(segment);
  };
  if (meta.exif) push(jpegSegment(0xffe1, Buffer.concat([EXIF_HEADER, meta.exif])));
  if (meta.xmp) push(jpegSegment(0xffe1, Buffer.concat([XMP_HEADER, meta.xmp])));
  if (meta.icc && profileSpace(meta.icc) === (components === 1 ? "GRAY" : "RGB ")) {
    const size = MAX_SEGMENT - ICC_HEADER.length - 2;
    const count = Math.ceil(meta.icc.length / size);
    if (count <= 255) {
      for (let i = 0; i < count; i++) {
        push(jpegSegment(0xffe2, Buffer.concat([ICC_HEADER, Buffer.from([i + 1, count]), meta.icc.subarray(i * size, (i + 1) * size)])));
      }
    }
  }
  if (meta.iptc) push(jpegSegment(0xffed, meta.iptc));
  // A JFIF header stays first, as JFIF requires.
  const jfif = kept[0] !== undefined && kept[0].readUInt16BE(0) === 0xffe0 ? [kept.shift()!] : [];
  return Buffer.concat([bytes.subarray(0, 2), ...jfif, ...added, ...kept, bytes.subarray(at)]);
}

// ----- WebP -----

function riffChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(type, 0, "latin1");
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function embedWebp(bytes: Buffer, meta: SourceMetadata): Buffer {
  const chunks: Array<{ type: string; data: Buffer }> = [];
  for (let at = 12; at + 8 <= bytes.length; ) {
    const type = bytes.toString("latin1", at, at + 4);
    const length = bytes.readUInt32LE(at + 4);
    chunks.push({ type, data: bytes.subarray(at + 8, at + 8 + length) });
    at += 8 + length + (length % 2);
  }
  let width = 0;
  let height = 0;
  let alpha = false;
  for (const { type, data } of chunks) {
    if (type === "VP8X") {
      width = data.readUIntLE(4, 3) + 1;
      height = data.readUIntLE(7, 3) + 1;
      alpha ||= (data[0]! & 0x10) !== 0;
    } else if (type === "VP8 " && width === 0) {
      width = data.readUInt16LE(6) & 0x3fff;
      height = data.readUInt16LE(8) & 0x3fff;
    } else if (type === "VP8L" && width === 0) {
      const bits = data.readUInt32LE(1);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
      alpha ||= ((bits >>> 28) & 1) === 1;
    } else if (type === "ALPH") {
      alpha = true;
    }
  }
  if (width === 0) return bytes;
  const image = chunks.filter((chunk) => !["VP8X", "ICCP", "EXIF", "XMP "].includes(chunk.type));
  const icc = meta.icc && profileSpace(meta.icc) === "RGB " ? meta.icc : undefined;
  const animated = image.some((chunk) => chunk.type === "ANIM");
  const flags = (icc ? 0x20 : 0) | (alpha ? 0x10 : 0) | (meta.exif ? 0x08 : 0) | (meta.xmp ? 0x04 : 0) | (animated ? 0x02 : 0);
  const header = Buffer.alloc(10);
  header[0] = flags;
  header.writeUIntLE(width - 1, 4, 3);
  header.writeUIntLE(height - 1, 7, 3);
  const body = Buffer.concat([
    riffChunk("VP8X", header),
    ...(icc ? [riffChunk("ICCP", icc)] : []),
    ...image.map((chunk) => riffChunk(chunk.type, chunk.data)),
    ...(meta.exif ? [riffChunk("EXIF", meta.exif)] : []),
    ...(meta.xmp ? [riffChunk("XMP ", meta.xmp)] : []),
  ]);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "latin1");
  riff.writeUInt32LE(body.length + 4, 4);
  riff.write("WEBP", 8, "latin1");
  return Buffer.concat([riff, body]);
}
