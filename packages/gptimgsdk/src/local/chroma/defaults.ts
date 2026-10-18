/**
 * All local-chroma defaults live here. Recipe entries and per-call arguments
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
