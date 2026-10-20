// sharp as the SDK uses it. libvips's operation cache is off: on Windows a
// cached image keeps its file open, so an image the SDK wrote and then read
// back (encode checks what it wrote) could not be renamed, replaced or deleted
// while the process lived.
import sharp from "sharp";

sharp.cache(false);

export default sharp;
