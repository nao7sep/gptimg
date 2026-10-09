import { maskUrlQuery } from "../log/mask.js";

const BASE64_FIELDS = new Set([
  "b64_json",
  "image_b64",
  "image_base64",
]);

/**
 * A provider response as gptimg records it, in the log and the sidecar: a copy
 * with base64 image payloads replaced by `null`, since the saved files hold
 * them, and each image `url`'s query values masked, since a signed download URL
 * carries its credential there (data-lifecycle-conventions). Field-name-based
 * detection (conservative); known field names from the OpenAI Images API are
 * nulled. Position of `response.data[i]` is preserved so it can be matched to
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
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (BASE64_FIELDS.has(k)) {
        out[k] = null;
      } else if (k === "url" && typeof val === "string") {
        out[k] = maskUrlQuery(val);
      } else {
        out[k] = walk(val);
      }
    }
    return out;
  }
  return v;
}
