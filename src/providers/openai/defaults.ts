export const OPENAI_MODEL_DEFAULTS = {
  generate: "gpt-image-2",
  edit: "gpt-image-2",
  vision: "gpt-5.4-mini",
} as const;

export const OPENAI_VISION_SYSTEM_PROMPT =
  "You are a strict image verification assistant. Given one or more images and a user-supplied criterion, decide whether the image(s) clearly satisfy the criterion. Return ok=true only when the criterion is clearly met. score is your confidence in [0, 1]. reasons is a list of concrete observations supporting your verdict (positive or negative).";

/**
 * The gpt-image-* models always return base64 and reject a `response_format`
 * parameter, so it must be omitted for them; other models accept it (and the
 * caller defaults it to "b64_json"). Model-capability knowledge, kept beside the
 * model defaults.
 */
export function shouldOmitResponseFormat(model: string): boolean {
  return model.startsWith("gpt-image");
}
