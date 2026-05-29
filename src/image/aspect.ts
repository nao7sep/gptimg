/**
 * Scale `(width, height)` so the longer side equals `toSize`, preserving aspect
 * ratio. Each axis is clamped to at least 1 px. Shared by `upscale` and
 * `resize`, which both express their target as a longer-side length.
 */
export function fitLongerSide(
  width: number,
  height: number,
  toSize: number,
): { w: number; h: number } {
  if (width >= height) {
    return { w: toSize, h: Math.max(1, Math.round((toSize * height) / width)) };
  }
  return { w: Math.max(1, Math.round((toSize * width) / height)), h: toSize };
}
