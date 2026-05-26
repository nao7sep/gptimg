/**
 * Pure-JS morphological operations on binary masks (Uint8Array of 0/255).
 * 3x3 structuring element, 8-connectivity. Iterated for multi-pixel kernels.
 */

export function dilate(
  mask: Uint8Array,
  width: number,
  height: number,
  iterations = 1,
): Uint8Array {
  let src = mask;
  for (let it = 0; it < iterations; it++) {
    const dst = new Uint8Array(src.length);
    for (let y = 0; y < height; y++) {
      const yStart = y > 0 ? y - 1 : 0;
      const yEnd = y < height - 1 ? y + 1 : height - 1;
      for (let x = 0; x < width; x++) {
        const xStart = x > 0 ? x - 1 : 0;
        const xEnd = x < width - 1 ? x + 1 : width - 1;
        let v = 0;
        outer: for (let yy = yStart; yy <= yEnd; yy++) {
          const row = yy * width;
          for (let xx = xStart; xx <= xEnd; xx++) {
            if (src[row + xx]! > 0) {
              v = 255;
              break outer;
            }
          }
        }
        dst[y * width + x] = v;
      }
    }
    src = dst;
  }
  return src;
}

export function erode(
  mask: Uint8Array,
  width: number,
  height: number,
  iterations = 1,
): Uint8Array {
  let src = mask;
  for (let it = 0; it < iterations; it++) {
    const dst = new Uint8Array(src.length);
    for (let y = 0; y < height; y++) {
      const yStart = y > 0 ? y - 1 : 0;
      const yEnd = y < height - 1 ? y + 1 : height - 1;
      for (let x = 0; x < width; x++) {
        const xStart = x > 0 ? x - 1 : 0;
        const xEnd = x < width - 1 ? x + 1 : width - 1;
        let v = 255;
        outer: for (let yy = yStart; yy <= yEnd; yy++) {
          const row = yy * width;
          for (let xx = xStart; xx <= xEnd; xx++) {
            if (src[row + xx]! === 0) {
              v = 0;
              break outer;
            }
          }
        }
        dst[y * width + x] = v;
      }
    }
    src = dst;
  }
  return src;
}

export function close(
  mask: Uint8Array,
  width: number,
  height: number,
  iterations = 1,
): Uint8Array {
  const dilated = dilate(mask, width, height, iterations);
  return erode(dilated, width, height, iterations);
}

/** Pixelwise A XOR B for binary masks. Result is 255 where exactly one is set. */
export function xorMasks(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== b.length) {
    throw new Error("xorMasks: length mismatch");
  }
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = (a[i]! > 0) !== (b[i]! > 0) ? 255 : 0;
  }
  return out;
}
