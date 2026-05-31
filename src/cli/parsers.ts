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
