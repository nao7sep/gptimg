import { InvalidArgumentError } from "commander";
import { isHexColor } from "../color.js";

/** Commander value parser: require a #rrggbb hex color, naming `name` on error. */
export function hexOption(name: string) {
  return (v: string): string => {
    if (!isHexColor(v)) {
      throw new InvalidArgumentError(`${name}: must be #rrggbb`);
    }
    return v;
  };
}

/**
 * Commander value parser: coerce to a finite number — format only. Semantic
 * bounds (sign, range, integer-ness) are NOT checked here: the SDK re-validates
 * every argument and is the single source of truth for those constraints.
 */
export function numberArg(name: string) {
  return (v: string): number => {
    // Number("") and Number(whitespace) are 0, which would silently accept an
    // empty flag value as zero — reject it as the non-number it is.
    const n = v.trim() === "" ? NaN : Number(v);
    if (!Number.isFinite(n)) {
      throw new InvalidArgumentError(`${name}: must be a number`);
    }
    return n;
  };
}

/**
 * Commander value parser: coerce an "x,y" pair to a point — format only. Whether
 * the components must be integers, and any magnitude limit, are the SDK's to
 * enforce.
 */
export function pointArg(name: string) {
  return (v: string): { x: number; y: number } => {
    const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(v.trim());
    if (!m) {
      throw new InvalidArgumentError(`${name}: must be "x,y"`);
    }
    return { x: Number(m[1]!), y: Number(m[2]!) };
  };
}
