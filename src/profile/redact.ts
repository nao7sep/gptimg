// Denied keys, stored lower-cased and matched by EXACT, case-insensitive name —
// never by substring, so `token` redacts a `token`/`Token` field but never
// `tokenCount` or `broken`. Seeded with the obvious secrets; extend here as
// needed (per the logging conventions' no-cross-app-taxonomy rule).
const SECRET_KEYS = new Set([
  "apikey",
  "authorization",
  "token",
  "password",
  "secret",
]);
const REDACTED = "[redacted]";

/**
 * Recursively walk a value and replace secret field values with "[redacted]".
 * Returns a new structure; does not mutate the input.
 *
 * This is the single point of truth for what counts as a secret. Both the
 * sidecar writer and the log writer pipe through this function before
 * serializing. Pure and total: it matches by field name only, never regex-scans
 * a string value, never edits a `message`, and always yields valid JSON.
 */
export function redact<T>(value: T): T {
  return redactInternal(value) as T;
}

function redactInternal(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map(redactInternal);
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.has(k.toLowerCase())) {
        result[k] = REDACTED;
      } else {
        result[k] = redactInternal(v);
      }
    }
    return result;
  }
  return value;
}
