// sharp as the SDK uses it. libvips keeps no files open in its cache: on
// Windows a cached image's open file meant an image the SDK wrote and then read
// back (encode checks what it wrote) could not be renamed, replaced or deleted
// while the process lived. The memory cache stays, since it holds no files.
import sharp from "sharp";

sharp.cache({ files: 0 });

export default sharp;
