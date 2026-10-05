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

/** Canonical filename extensions this SDK can emit after format detection. */
export const SUPPORTED_IMAGE_EXTENSIONS = [...new Set(Object.values(FORMAT_TO_EXT))] as readonly string[];
