// A recipe checked against the chosen model's row before any paid call
// (ai-model-routing-conventions). An id with no row is not checked: its request is the plain
// one, and OpenAI's answer at call time is the verdict on it.

import { SUPPORTED_MODELS, type ImageModelRow, type VisionModelRow } from "../ai-models.js";
import { RecipeError } from "../errors.js";
import type { VisionDetail } from "../types.js";
import { VISION_DEFAULTS } from "../verbs/defaults.js";

type ImageSection = "generate" | "edit";

function imageRow(model: string): ImageModelRow | undefined {
  return SUPPORTED_MODELS.find((row): row is ImageModelRow => "image" in row && row.id === model);
}

function visionRow(model: string): VisionModelRow | undefined {
  return SUPPORTED_MODELS.find((row): row is VisionModelRow => "thinking" in row && row.id === model);
}

function refuse(section: string, message: string): never {
  throw new RecipeError("recipe.validationFailed", `${section} section invalid: ${message}`);
}

function listed(values: readonly string[]): string {
  return values.join(", ");
}

function checkListed(section: string, model: string, field: string, value: unknown, allowed: readonly string[]): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !allowed.includes(value)) {
    refuse(section, `${model} takes ${field} ${listed(allowed)}, not ${JSON.stringify(value)}.`);
  }
}

function checkSize(section: string, row: ImageModelRow, value: unknown): void {
  if (value === undefined || value === "auto") return;
  const rule = row.image.size;
  const match = typeof value === "string" ? /^(\d+)x(\d+)$/.exec(value) : null;
  if (!match) refuse(section, `${row.id} takes size "auto" or WIDTHxHEIGHT, not ${JSON.stringify(value)}.`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  if (width % rule.multipleOf !== 0 || height % rule.multipleOf !== 0) {
    refuse(section, `${row.id} takes sizes whose sides are divisible by ${rule.multipleOf}, not ${value}.`);
  }
  if (Math.max(width, height) > rule.maxRatio * Math.min(width, height)) {
    refuse(section, `${row.id} takes sizes up to a ${rule.maxRatio}:1 ratio, not ${value}.`);
  }
  if (pixels < rule.minPixels || pixels > rule.maxPixels) {
    refuse(
      section,
      `${row.id} takes sizes of ${rule.minPixels.toLocaleString("en-US")} to ${rule.maxPixels.toLocaleString("en-US")} pixels, not ${value} (${pixels.toLocaleString("en-US")}).`,
    );
  }
}

/** Refuses a generate or edit request whose values the chosen supported model does not take. */
export function checkImageParams(section: ImageSection, params: Readonly<Record<string, unknown>>): void {
  const model = params.model;
  if (typeof model !== "string") return;
  const row = imageRow(model);
  if (!row) return;
  const { qualities, backgrounds, outputFormats, compression } = row.image;
  checkListed(section, model, "quality", params.quality, qualities);
  checkListed(section, model, "background", params.background, backgrounds);
  checkListed(section, model, "output_format", params.output_format, outputFormats);
  // OpenAI's own default format is png, which takes neither compression nor a jpeg's opacity.
  const format = typeof params.output_format === "string" ? params.output_format : "png";
  if (params.background === "transparent" && !["png", "webp"].includes(format)) {
    refuse(section, `a transparent background needs output_format png or webp, not ${format}.`);
  }
  const level = params.output_compression;
  if (level !== undefined) {
    if (!compression.formats.includes(format)) {
      refuse(section, `output_compression applies to output_format ${compression.formats.join(" or ")} only, not ${format}.`);
    }
    if (typeof level !== "number" || !Number.isInteger(level) || level < compression.min || level > compression.max) {
      refuse(section, `${model} takes output_compression ${compression.min} to ${compression.max}, not ${JSON.stringify(level)}.`);
    }
  }
  checkSize(section, row, params.size);
}

/**
 * The moderation a generate call sends: "low", the most permissive value
 * (ai-model-lineup-20261004), for a supported model; none for an id with no row.
 */
export function resolveGenerateModeration(model: string): "low" | undefined {
  return imageRow(model) ? "low" : undefined;
}

/**
 * The reasoning effort a vision call sends: the recipe's value, checked against the supported
 * model's list, else that model's own default. An id with no row sends the recipe's value
 * unchecked, or none when the recipe sets none.
 */
export function resolveVisionReasoning(model: string, chosen: string | undefined): string | undefined {
  const row = visionRow(model);
  if (!row) return chosen;
  if (chosen === undefined) return row.defaultThinking;
  checkListed("vision", model, "reasoning", chosen, row.thinking);
  return chosen;
}

/**
 * The image detail a vision call sends: the recipe's value, else `auto`, for a supported model.
 * An id with no row sends the recipe's value, or none when the recipe sets none.
 */
export function resolveVisionDetail(model: string, chosen: VisionDetail | undefined): VisionDetail | undefined {
  if (!visionRow(model)) return chosen;
  return chosen ?? VISION_DEFAULTS.detail;
}
