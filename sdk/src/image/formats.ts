/**
 * The filename extension for each format sharp detects. This module does not
 * import sharp, so code that only names files does not load it.
 */
export const FORMAT_TO_EXT: Readonly<Record<string, string>> = {
  jpeg: "jpg",
  png: "png",
  webp: "webp",
  gif: "gif",
  tiff: "tiff",
  avif: "avif",
  heif: "heif",
  jxl: "jxl",
};

/** The extension a file encoded as `format` takes: `jpg` for JPEG, else the format's own name. */
export function extensionFor(format: string): string {
  return FORMAT_TO_EXT[format] ?? format;
}

/** Canonical filename extensions this SDK can emit after format detection. */
export const SUPPORTED_IMAGE_EXTENSIONS = [...new Set(Object.values(FORMAT_TO_EXT))] as readonly string[];
