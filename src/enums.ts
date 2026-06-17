/**
 * Single source of truth for every closed-set argument enum: the runtime token
 * lists AND the TypeScript union types derived from them. The CLI's enum-token
 * recognition (commander `.choices()`) and the SDK's argument validation
 * (verbs/schemas.ts) both import these same arrays, so the accepted set can
 * never drift between the two layers.
 */

/**
 * Corner shape for the backplate:
 * - "rect": circular-arc rounded corners (standard SVG rounded rect).
 * - "squircle": quarter-superellipse corners (smoother continuous curvature,
 *   closer to the macOS dock icon shape).
 */
export const BACKPLATE_SHAPES = ["rect", "squircle"] as const;
export type BackplateShape = (typeof BACKPLATE_SHAPES)[number];

/**
 * Where to anchor the top image on the base when no explicit pixel offset is
 * given. Matches sharp's compass directions.
 */
export const LAYER_GRAVITIES = [
  "center",
  "north",
  "south",
  "east",
  "west",
  "northeast",
  "northwest",
  "southeast",
  "southwest",
] as const;
export type LayerGravity = (typeof LAYER_GRAVITIES)[number];

/** Resampling kernel for image resize (sharp kernels). */
export const RESAMPLE_KERNELS = [
  "nearest",
  "cubic",
  "mitchell",
  "lanczos2",
  "lanczos3",
] as const;
export type ResampleKernel = (typeof RESAMPLE_KERNELS)[number];

export const MASK_METHODS = ["chroma", "ai"] as const;
export type MaskMethod = (typeof MASK_METHODS)[number];

export const COMBINE_OPS = [
  "union",
  "intersect",
  "subtract",
  "invert",
  "feather",
] as const;
export type CombineOp = (typeof COMBINE_OPS)[number];

/** Which connected components `despeckle` keeps. */
export const DESPECKLE_KEEP = ["all", "largest"] as const;
export type DespeckleKeep = (typeof DESPECKLE_KEEP)[number];

export const VISION_DETAILS = ["low", "high", "original", "auto"] as const;
export type VisionDetail = (typeof VISION_DETAILS)[number];
