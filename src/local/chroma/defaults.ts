/**
 * All local-chroma defaults live here. CLI flags and recipe entries override
 * these at runtime; this file is the single source of truth.
 *
 * Prompt strings include `{color}` placeholders that are substituted with the
 * resolved key color before being sent to the AI.
 */
export const CHROMA_DEFAULTS = {
  mode: "outer" as const,
  key: "auto" as const,
  innerThreshold: 5,
  metric: "lab_de76" as const,
  borderSample: 4,
  despill: true,
  fillHoles: true,
  verifyThreshold: 0,
} as const;

export const CHROMA_BACKDROP_INSTRUCTION =
  "\n\nThe subject is placed on a solid {color} chroma-key background " +
  "suitable for clean removal. The background should be uniform and not " +
  "overlap the subject in tone.";

export const CHROMA_VERIFY_INSTRUCTION =
  "Transparency and alpha-channel correctness are checked locally. " +
  "For this vision check, inspect the checkerboard preview for subject integrity, visible halos, and visual artifacts.";
