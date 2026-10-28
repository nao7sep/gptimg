// An exact image size, checked against the chosen image model's rule from the
// SDK before it is sent, so a size the model refuses is caught in the composer.
import { sizeProblem as sdkSizeProblem, type ImageSizeRule, type SizeProblem } from "gptimgsdk/types";
import { builtInSettings, imageRow } from "./settings.ts";

/** The default image model's rule, for showing sizes when the chosen model has no row. */
export const DEFAULT_SIZE_RULE: ImageSizeRule = imageRow(builtInSettings()["openai.image"])!.image.size;

/** The size rule of a supported image model, or null for one the SDK does not list. */
export function sizeRuleOf(model: string): ImageSizeRule | null {
  return imageRow(model)?.image.size ?? null;
}

/** What is wrong with a width and height under a rule, or null when the model takes them; with no rule only the form is checked. */
export function sizeProblem(width: number, height: number, rule: ImageSizeRule | null): SizeProblem | null {
  return sdkSizeProblem(width, height, rule ?? ANY_SIZE);
}

const ANY_SIZE: ImageSizeRule = { multipleOf: 1, maxRatio: Infinity, minPixels: 0, maxPixels: Infinity };

export function parseSize(size: string): { width: number; height: number } | null {
  const match = /^(\d+)x(\d+)$/.exec(size);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}
