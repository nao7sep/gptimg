import { maskUrlQuery } from "../events/mask.ts";

const BASE64_FIELDS = new Set([
  "b64_json",
  "image_b64",
  "image_base64",
]);

/**
 * A provider response as gptimg records it, in its events and the sidecar: a copy
 * with base64 image payloads replaced by `null`, since the saved files hold
 * them, and each image `url`'s query values masked, since a signed download URL
 * carries its credential there (data-lifecycle-conventions). Field-name-based
 * detection (conservative): known field names from the OpenAI Images API, and
 * the `result` of a Responses API `image_generation_call`, are nulled.
 * Position of `response.data[i]` is preserved so it can be matched to
 * the saved file with `index === i + 1`.
 */
export function nullBase64InResponse(response: unknown): unknown {
  return walk(response);
}

function walk(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) {
    return v.map(walk);
  }
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    // The Responses API returns a generated image as an image_generation_call item's `result`.
    const imageCall = (v as { type?: unknown }).type === "image_generation_call";
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const isPayload = BASE64_FIELDS.has(k) || (imageCall && k === "result" && typeof val === "string");
      const value = isPayload ? null : k === "url" && typeof val === "string" ? maskUrlQuery(val) : walk(val);
      // Defined, not assigned, so a field named "__proto__" stays a field.
      Object.defineProperty(out, k, { value, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return v;
}
