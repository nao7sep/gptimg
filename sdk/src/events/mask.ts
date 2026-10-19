/**
 * Credential masking for diagnostic copies (data-lifecycle-conventions,
 * *Credentials*): a credential value becomes the fixed marker, while field
 * names, nesting, an authorization scheme (`Bearer [REDACTED]`) and every
 * other value stay as they were. Live requests are never touched; callers mask
 * the copy a sink receives.
 */
export const REDACTED = "[REDACTED]";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A provider's own partial echo of a credential: OpenAI's 401 message quotes
 * the key as its first characters, a run of asterisks and its last four
 * (`sk-proj-****…abcd`), which still discloses a third of a short key.
 */
function partialEcho(credential: string): RegExp | null {
  if (credential.length < 16) return null;
  return new RegExp(`${escapeRegExp(credential.slice(0, 3))}[^\\s*]*\\*{4,}${escapeRegExp(credential.slice(-4))}`, "g");
}

/** `text` with every occurrence of each credential, and a provider's partial echo of it, replaced by the marker. */
export function maskCredentials(text: string, credentials: Iterable<string>): string {
  let out = text;
  for (const credential of credentials) {
    if (credential.length === 0) continue;
    out = out.replaceAll(credential, REDACTED);
    const echo = partialEcho(credential);
    if (echo) out = out.replace(echo, (match) => (credential.startsWith(match.slice(0, match.indexOf("*"))) ? REDACTED : match));
  }
  return out;
}

/**
 * Copy JSON and errors for a diagnostic sink, keeping prototypes, own fields
 * (including nonenumerable stack/cause), and graph identity. Headers need a
 * real instance so SDK callers can still inspect response metadata, as do
 * native DOMException causes with diagnostic getters backed by hidden slots. Own
 * accessors, including V8's lazy Error.stack, become their snapshot values.
 */
export function maskDiagnosticCopy<T>(value: T, credentials: Iterable<string>): T {
  const values = [...credentials];
  const copies = new Map<object, object>();
  const copy = (current: unknown): unknown => {
    if (typeof current === "string") return maskCredentials(current, values);
    if (current === null || typeof current !== "object") return current;
    const previous = copies.get(current);
    if (previous) return previous;
    if (current instanceof Headers) {
      const headers = new Headers();
      copies.set(current, headers);
      for (const [name, content] of current) headers.append(name, maskCredentials(content, values));
      return headers;
    }
    // A real Error retains its native identity, without invoking an SDK or
    // caller-defined constructor. Its original descriptors replace this stack.
    const out = current instanceof DOMException
      ? new DOMException(maskCredentials(current.message, values), current.name)
      : current instanceof Error ? new Error() : Array.isArray(current) ? [] : Object.create(Object.getPrototypeOf(current));
    if (current instanceof Error) delete out.stack;
    Object.setPrototypeOf(out, Object.getPrototypeOf(current));
    copies.set(current, out);
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
      const masked = "value" in descriptor
        ? { ...descriptor, value: copy(descriptor.value) }
        : { enumerable: descriptor.enumerable, configurable: descriptor.configurable, value: copy(Reflect.get(current, key)), writable: false };
      Object.defineProperty(out, key, masked);
    }
    return out;
  };
  return copy(value) as T;
}

/** Raw and standard decoded query values, covering URL and server echoes. */
export function urlQueryValues(url: string): string[] {
  const query = url.split("#", 1)[0]!.split("?").slice(1).join("?");
  if (query.length === 0) return [];
  return [...new Set(query.split("&").flatMap((pair) => {
    const eq = pair.indexOf("=");
    const value = eq < 0 ? "" : pair.slice(eq + 1);
    // URLSearchParams handles '+' as a space and tolerates malformed escapes.
    const decoded = new URLSearchParams(pair).values().next().value ?? "";
    return value.length > 0 ? [value, decoded] : [];
  }))];
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
