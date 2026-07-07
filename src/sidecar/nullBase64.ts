const BASE64_FIELDS = new Set([
  "b64_json",
  "image_b64",
  "image_base64",
]);

/**
 * Walk a provider response and replace base64 image payloads with `null`
 * in place, preserving position. Field-name-based detection (conservative);
 * known field names from the OpenAI Images API are nulled. Position of
 * `response.data[i]` is preserved so it can be matched to the saved file
 * with `index === i + 1`.
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
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (BASE64_FIELDS.has(k)) {
        out[k] = null;
      } else {
        out[k] = walk(val);
      }
    }
    return out;
  }
  return v;
}
