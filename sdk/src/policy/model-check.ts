// A policy checked against the chosen model's row before any paid call
// (ai-model-routing-conventions). An id with no row is not checked: its request is the plain
// one, and OpenAI's answer at call time is the verdict on it.

import { findModelRow, sizeProblem, type ImageModelRow, type VisionModelRow } from "../ai-models.ts";
import { GptImgError } from "../errors.ts";
import type { VisionDetail } from "../types.ts";
import { VISION_DEFAULTS } from "../defaults.ts";

type ImageSection = "generate" | "edit" | "chat";

function imageRow(model: string): ImageModelRow | undefined {
  const row = findModelRow(model);
  return row && "image" in row ? row : undefined;
}

function visionRow(model: string): VisionModelRow | undefined {
  const row = findModelRow(model);
  return row && "thinking" in row ? row : undefined;
}

function invalidPolicy(section: string, message: string): never {
  throw new GptImgError("policy.invalid", `${section} policy invalid: ${message}`, { details: { section } });
}

function listed(values: readonly string[]): string {
  return values.join(", ");
}

function checkListed(section: string, model: string, field: string, value: unknown, allowed: readonly string[]): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !allowed.includes(value)) {
    invalidPolicy(section, `${model} takes ${field} ${listed(allowed)}, not ${JSON.stringify(value)}.`);
  }
}

function checkSize(section: string, row: ImageModelRow, value: unknown): void {
  if (value === undefined || value === "auto") return;
  const rule = row.image.size;
  const match = typeof value === "string" ? /^(\d+)x(\d+)$/.exec(value) : null;
  if (!match) invalidPolicy(section, `${row.id} takes size "auto" or WIDTHxHEIGHT, not ${JSON.stringify(value)}.`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  const problem = sizeProblem(width, height, rule);
  if (problem === "multiple") {
    invalidPolicy(section, `${row.id} takes sizes whose sides are divisible by ${rule.multipleOf}, not ${value}.`);
  }
  if (problem === "ratio") invalidPolicy(section, `${row.id} takes sizes up to a ${rule.maxRatio}:1 ratio, not ${value}.`);
  if (problem === "format" || problem === "small" || problem === "large") {
    invalidPolicy(
      section,
      `${row.id} takes sizes of ${rule.minPixels.toLocaleString("en-US")} to ${rule.maxPixels.toLocaleString("en-US")} pixels, not ${value} (${pixels.toLocaleString("en-US")}).`,
    );
  }
}

/** Refuses a generate, edit or chat image request whose values the chosen supported image model does not take. */
export function checkImageParams(section: ImageSection, params: Readonly<Record<string, unknown>>): void {
  const model = params.model;
  if (typeof model !== "string") return;
  const row = imageRow(model);
  if (!row) return;
  const { qualities, backgrounds, outputFormats, compression, transparentFormats } = row.image;
  checkListed(section, model, "quality", params.quality, qualities);
  checkListed(section, model, "background", params.background, backgrounds);
  checkListed(section, model, "output_format", params.output_format, outputFormats);
  // OpenAI's own default format is png, which takes neither compression nor a jpeg's opacity.
  const format = typeof params.output_format === "string" ? params.output_format : "png";
  if (params.background === "transparent" && !transparentFormats.includes(format)) {
    invalidPolicy(section, `a transparent background needs output_format ${transparentFormats.join(" or ")}, not ${format}.`);
  }
  const level = params.output_compression;
  if (level !== undefined) {
    if (!compression.formats.includes(format)) {
      invalidPolicy(section, `output_compression applies to output_format ${compression.formats.join(" or ")} only, not ${format}.`);
    }
    if (typeof level !== "number" || !Number.isInteger(level) || level < compression.min || level > compression.max) {
      invalidPolicy(section, `${model} takes output_compression ${compression.min} to ${compression.max}, not ${JSON.stringify(level)}.`);
    }
  }
  checkSize(section, row, params.size);
}

/**
 * The moderation a generate call sends: "low", the most permissive value, so
 * ordinary requests are not blocked, for a supported model; none for an id with no row.
 */
export function resolveGenerateModeration(model: string): "low" | undefined {
  return imageRow(model) ? "low" : undefined;
}

/**
 * The reasoning effort a vision or chat call sends: the policy's value, checked against the supported
 * model's list, else that model's own default. An id with no row sends the policy's value
 * unchecked, or none when the policy sets none.
 */
export function resolveVisionReasoning(model: string, chosen: string | undefined, section: "vision" | "chat" = "vision"): string | undefined {
  const row = visionRow(model);
  if (!row) return chosen;
  if (chosen === undefined) return row.defaultThinking;
  checkListed(section, model, "reasoning", chosen, row.thinking);
  return chosen;
}

/**
 * The moderation the chat's image tool sends: "low", as `generate` sends, for a supported image
 * model; none for an id with no row.
 */
export function resolveChatModeration(imageModel: string): "low" | undefined {
  return resolveGenerateModeration(imageModel);
}

/**
 * The image detail a vision call sends: the policy's value, else `auto`, for a supported model.
 * An id with no row sends the policy's value, or none when the policy sets none.
 */
export function resolveVisionDetail(model: string, chosen: VisionDetail | undefined): VisionDetail | undefined {
  if (!visionRow(model)) return chosen;
  return chosen ?? VISION_DEFAULTS.detail;
}
