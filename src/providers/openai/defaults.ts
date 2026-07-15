/**
 * The models a caller gets when it passes no `model` param. Each is free text and
 * overridable per call; these are only the starting points, verified against the
 * live API when chosen (2026-07-16) rather than taken from docs.
 *
 * `vision` moved off gpt-5.4-mini, on which `detail` is inert — low, high, and
 * original all billed 2621 prompt tokens for one 1536x1536 image. gpt-5.6-luna
 * honors it: the same image costs 320 tokens at detail=low, 2621 at high. So the
 * detail knob only does anything from this default onward.
 */
export const OPENAI_MODEL_DEFAULTS = {
  generate: "gpt-image-2",
  edit: "gpt-image-2",
  vision: "gpt-5.6-luna",
} as const;

export const OPENAI_VISION_SYSTEM_PROMPT =
  "You are a strict image verification assistant. Given one or more images and a user-supplied criterion, decide whether the image(s) clearly satisfy the criterion. Return ok=true only when the criterion is clearly met. score is your confidence in [0, 1]. reasons is a list of concrete observations supporting your verdict (positive or negative).";
