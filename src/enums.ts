/**
 * Single source of truth for every closed-set argument enum: the runtime token
 * lists AND the TypeScript union types derived from them. The SDK's argument
 * validation (verbs/schemas.ts) imports these same arrays, so the accepted
 * tokens and the derived type can never drift apart.
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

/**
 * Which axis (axes) `framecheck`'s centering verdict enforces. The geometry
 * result always reports BOTH horizontal and vertical deltas; this only selects
 * which the pass/fail verdict is computed from.
 *
 * - "horizontal": only |left − right| (the default — a baked drop shadow is
 *   usually a vertical offset, so the horizontal pair is the residue-skew signal
 *   that is symmetric by contract).
 * - "vertical": only |top − bottom|.
 * - "both": both pairs must be within tolerance.
 */
export const FRAMECHECK_AXES = ["horizontal", "vertical", "both"] as const;
export type FramecheckAxes = (typeof FRAMECHECK_AXES)[number];
