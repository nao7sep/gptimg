/**
 * Shared hex-color helpers. Verb-neutral: parsing and validation used by
 * backplate, compose, mask, shadow, and the recipe schema. No I/O.
 */

import { LocalOpError } from "./errors.js";

/**
 * Matches a "#rrggbb" hex color — the leading "#" is required. Capture group 1
 * is the six hex digits (no "#").
 */
export const HEX_RE = /^#([0-9a-fA-F]{6})$/;

/** True if `value` is a "#rrggbb" hex color. */
export function isHexColor(value: string): boolean {
  return HEX_RE.test(value);
}

/**
 * Parse a hex color to an [r, g, b] byte triple. Assumes a valid "#rrggbb" hex;
 * validate with `isHexColor`/`normalizeHex` first.
 */
export function parseHex(hex: string): [number, number, number] {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/**
 * Validate and canonicalize a hex color to lowercase "#rrggbb". `label` names
 * the offending value in the error message (e.g. "--from"). Throws LocalOpError
 * (args.invalid) on malformed input.
 */
export function normalizeHex(hex: string, label = "color"): string {
  const m = HEX_RE.exec(hex);
  if (!m) {
    throw new LocalOpError(
      "args.invalid",
      `${label} must be #rrggbb; got "${hex}".`,
    );
  }
  return `#${m[1]!.toLowerCase()}`;
}
