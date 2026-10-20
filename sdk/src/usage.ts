import type { Usage } from "./types.ts";

function count(record: unknown, field: string): number | undefined {
  const value = record !== null && typeof record === "object" ? (record as Record<string, unknown>)[field] : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The tokens a provider response reports, in each OpenAI wire format the SDK
 * calls: the Responses API and the images endpoint (`input_tokens`,
 * `output_tokens`, and a chat turn's `tool_usage.image_gen`), and chat
 * completions (`prompt_tokens`, `completion_tokens`). Null when it reports none.
 */
export function usageOf(response: unknown): Usage | null {
  const usage = (response as { usage?: unknown } | null)?.usage;
  if (usage === null || typeof usage !== "object") return null;
  const image = (response as { tool_usage?: { image_gen?: unknown } }).tool_usage?.image_gen;
  const imageInput = count(image, "input_tokens");
  const imageOutput = count(image, "output_tokens");
  return {
    input: count(usage, "input_tokens") ?? count(usage, "prompt_tokens") ?? 0,
    output: count(usage, "output_tokens") ?? count(usage, "completion_tokens") ?? 0,
    ...(imageInput !== undefined && { imageInput }),
    ...(imageOutput !== undefined && { imageOutput }),
  };
}

/** The provider's id for a response, when its wire format gives one (the images endpoint does not). */
export function responseIdOf(response: unknown): string | null {
  const id = (response as { id?: unknown } | null)?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
