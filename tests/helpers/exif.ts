/**
 * Read an EXIF block's IFD0, Exif and GPS tags by number, as strings, so a
 * test can check what an encoded image carries independently of the code that
 * wrote it. Rationals read as `n/d`; types a test does not need read as null.
 */
export function readExifTags(exif: Buffer): Record<"ifd0" | "exif" | "gps", Map<number, string | null>> {
  const tiff = exif.subarray(0, 6).toString("latin1") === "Exif\0\0" ? exif.subarray(6) : exif;
  const le = tiff.toString("latin1", 0, 2) === "II";
  const u16 = (o: number): number => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number): number => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const sizes: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const read = (offset: number): Map<number, string | null> => {
    const tags = new Map<number, string | null>();
    for (let i = 0; i < u16(offset); i++) {
      const at = offset + 2 + i * 12;
      const type = u16(at + 2);
      const n = u32(at + 4);
      const start = (sizes[type] ?? 1) * n <= 4 ? at + 8 : u32(at + 8);
      const each = (size: number, f: (o: number) => string): string =>
        Array.from({ length: n }, (_, k) => f(start + size * k)).join(" ");
      let value: string | null = null;
      if (type === 2) value = tiff.toString("utf-8", start, start + n).replace(/\0+$/, "");
      if (type === 1) value = each(1, (o) => String(tiff[o]));
      if (type === 3) value = each(2, (o) => String(u16(o)));
      if (type === 4) value = each(4, (o) => String(u32(o)));
      if (type === 5) value = each(8, (o) => `${u32(o)}/${u32(o + 4)}`);
      tags.set(u16(at), value);
    }
    return tags;
  };
  const ifd0 = read(u32(4));
  const sub = (tag: number): Map<number, string | null> => {
    const at = ifd0.get(tag);
    return at ? read(Number(at)) : new Map();
  };
  return { ifd0, exif: sub(0x8769), gps: sub(0x8825) };
}
