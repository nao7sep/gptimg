// Every verb's default values, in one module with no dependencies, so both
// entries export them and the public types refer to them instead of restating
// a value a change could leave wrong.
import type { BackplateShape, FramecheckAxes, LayerGravity, ResampleKernel, VisionDetail } from "./enums.ts";
import { SWIN2SR_DEFAULT_TILE } from "./local/models/swin2sr-constants.ts";
import type { ShadowOffset } from "./types.ts";

/** The encoding of a verb that writes an image, when the call names none. */
export const ENCODING_DEFAULTS = {
  format: "png",
} as const;

/** ONNX Runtime's tuning, when `policy.onnx` sets none; the thread count defaults to half the cores. */
export const ONNX_DEFAULTS = {
  executionProviders: ["cpu"] as readonly string[],
} as const;

export const BACKPLATE_DEFAULTS = {
  size: 1024,
  content: 0.8,
  radius: 0.225,
  angle: 135,
  shape: "rect" as BackplateShape,
} as const;

/**
 * All local-chroma defaults live here. Policy entries and per-call arguments
 * override these at runtime; this file is the single source of truth.
 */
export const CHROMA_DEFAULTS = {
  /**
   * Default false: interior key-colored regions are removed (e.g. tiny gaps
   * between hair strands disappear cleanly). Set to true to keep interior
   * key-colored regions opaque (donut hole, intentional green subject).
   */
  preserveInterior: false,
  key: "auto" as const,
  /** Border-sample depth in pixels for `key: "auto"`. */
  borderSample: 4,
  /**
   * Spill ratio at which a pixel saturates to fully transparent. The auto-key
   * is the average of border pixels, so true-bg pixels vary slightly around
   * it; a value < 1 snaps near-key pixels to α=0 instead of leaving a faint
   * haze across the background. AI-generated chroma backdrops often carry
   * sub-visible texture in the bg that maps to α≈10–20 with a generous
   * ratio, showing up in the composite as wispy "streaks" that look like
   * hair fibers. 0.82 reliably absorbs that floor while keeping real wispy
   * hair edges (which sit closer to α≈40+) intact.
   */
  saturationRatio: 0.82,
} as const;

export const DESPECKLE_DEFAULTS = {
  threshold: 5,
  minArea: 0,
  connectivity: 8,
  keep: "all",
} as const;

export const FRAMECHECK_DEFAULTS = {
  threshold: 128,
  tolerance: 2,
  axes: "horizontal" as FramecheckAxes,
} as const;

export const GRID_DEFAULTS = {
  cell: 256,
  gap: 16,
  background: "transparent",
} as const;

export const ICON_DEFAULTS = {
  name: "icon",
  pngs: false,
} as const;

export const KEYCHECK_DEFAULTS = {
  hueTolerance: 20,
  minSaturation: 0.35,
  minValue: 0.25,
  maxEdgeResidueFraction: 0.02,
  maxInteriorResiduePixels: 0,
} as const;

export const LAYER_DEFAULTS = {
  gravity: "center" as LayerGravity,
} as const;

export const RESIZE_DEFAULTS = {
  kernel: "lanczos3" as ResampleKernel,
} as const;

export const SHADOW_DEFAULTS = {
  blur: 12,
  offset: { x: 0, y: 8 } as ShadowOffset,
  color: "#000000",
  opacity: 0.35,
  spread: 0,
  keepCanvas: false,
} as const;

export const TRIM_DEFAULTS = {
  margin: 0.08,
  square: false,
} as const;

export const UPSCALE_DEFAULTS = {
  toSize: 1024,
  kernel: "lanczos3" as ResampleKernel,
  tile: SWIN2SR_DEFAULT_TILE,
} as const;

export const VISION_DEFAULTS: { readonly shrink: { width: number; height: number }; readonly detail: VisionDetail } = {
  shrink: { width: 1024, height: 1024 },
  // OpenAI's literal `auto`, sent as chosen when the policy sets no detail.
  detail: "auto",
};
