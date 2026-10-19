// An exact image size, checked against the chosen image model's rule before
// it is sent, so a size the model refuses is caught in the composer.
import { SUPPORTED_MODELS } from "gptimgsdk/types";

export interface SizeRule {
  multipleOf: number;
  maxRatio: number;
  minPixels: number;
  maxPixels: number;
}

/** The size rule of a supported image model, or null for one the SDK does not list. */
export function sizeRuleOf(model: string): SizeRule | null {
  const want = model.trim().toLowerCase();
  const row = SUPPORTED_MODELS.find((r) => r.id === want && "image" in r) as { image: { size: SizeRule } } | undefined;
  return row?.image.size ?? null;
}

export type SizeProblem = "format" | "multiple" | "ratio" | "small" | "large";

/** What is wrong with a width and height under a rule, or null when the model takes them. */
export function sizeProblem(width: number, height: number, rule: SizeRule | null): SizeProblem | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return "format";
  if (!rule) return null;
  if (width % rule.multipleOf !== 0 || height % rule.multipleOf !== 0) return "multiple";
  if (Math.max(width, height) > rule.maxRatio * Math.min(width, height)) return "ratio";
  if (width * height < rule.minPixels) return "small";
  if (width * height > rule.maxPixels) return "large";
  return null;
}

export function parseSize(size: string): { width: number; height: number } | null {
  const match = /^(\d+)x(\d+)$/.exec(size);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}
