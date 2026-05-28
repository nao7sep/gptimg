/**
 * All local-chroma defaults live here. CLI flags and recipe entries override
 * these at runtime; this file is the single source of truth.
 */
export const CHROMA_DEFAULTS = {
  /**
   * Default false: interior key-colored regions are removed (e.g. tiny gaps
   * between hair strands disappear cleanly). Set to true to keep interior
   * key-colored regions opaque (donut hole, intentional green subject).
   */
  preserveInterior: false,
  key: "auto" as const,
  innerThreshold: 5,
  metric: "lab_de76" as const,
  borderSample: 4,
  fillHoles: true,
} as const;
