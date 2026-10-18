import type { MaskArgs, MaskPolicy } from "../types.ts";

/**
 * Fill the unset chroma-mask args from the policy's `chroma` section. An arg the
 * caller passed explicitly always wins — only `undefined` fields fall back — and
 * `key` falls back to a non-empty `color` string only, so a blank policy color
 * leaves `key` unset (i.e. "auto"). Pure: returns a new args object, never
 * mutating the input.
 */
export function applyChromaPolicyDefaults(args: MaskArgs, section: MaskPolicy): MaskArgs {
  const merged: MaskArgs = { ...args };
  if (merged.preserveInterior === undefined && section.preserveInterior !== undefined) {
    merged.preserveInterior = section.preserveInterior;
  }
  if (
    merged.key === undefined &&
    typeof section.color === "string" &&
    section.color.length > 0
  ) {
    merged.key = section.color;
  }
  if (merged.borderSample === undefined && section.borderSample !== undefined) {
    merged.borderSample = section.borderSample;
  }
  if (merged.saturationRatio === undefined && section.saturationRatio !== undefined) {
    merged.saturationRatio = section.saturationRatio;
  }
  return merged;
}
