/**
 * Credential masking for diagnostic copies (data-lifecycle-conventions,
 * *Credentials*): a credential value becomes the fixed marker, while field
 * names, nesting, an authorization scheme (`Bearer [REDACTED]`) and every
 * other value stay as they were. Live requests are never touched; callers mask
 * the copy a sink receives.
 */
export const REDACTED = "[REDACTED]";

/** `text` with every occurrence of each credential replaced by the marker. */
export function maskCredentials(text: string, credentials: Iterable<string>): string {
  let out = text;
  for (const credential of credentials) {
    if (credential.length > 0) out = out.replaceAll(credential, REDACTED);
  }
  return out;
}

/** The raw (still encoded) query values of `url`, as they appear in text that echoes it. */
export function urlQueryValues(url: string): string[] {
  const query = url.split("#", 1)[0]!.split("?").slice(1).join("?");
  if (query.length === 0) return [];
  return query.split("&").flatMap((pair) => {
    const eq = pair.indexOf("=");
    const value = eq < 0 ? "" : pair.slice(eq + 1);
    return value.length > 0 ? [value] : [];
  });
}

/**
 * `url` with each query value replaced by the marker: a signed download URL
 * carries its credential there. A URL that does not parse is returned as is.
 */
export function maskUrlQuery(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.search.length === 0) return url;
  const query = [...parsed.searchParams.keys()].map((key) => `${encodeURIComponent(key)}=${REDACTED}`).join("&");
  return `${parsed.origin}${parsed.pathname}?${query}${parsed.hash}`;
}
