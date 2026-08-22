import { ProfileError } from "../errors.js";

const MARKER = "obf:";

// Reverse a byte sequence on a copy, never mutating the input. Operating on the
// UTF-8 bytes (not on string characters) keeps this byte-for-byte identical to
// the api-key-storage convention's canonical `obf:` algorithm in every language;
// for the ASCII keys stored in practice it is the same result either way.
function reverseBytes(bytes: Buffer): Buffer {
  return Buffer.from(bytes).reverse();
}

export function obfuscate(raw: string): string {
  const reversed = reverseBytes(Buffer.from(raw, "utf-8"));
  return MARKER + reversed.toString("base64");
}

export function deobfuscate(stored: string): string {
  if (!stored.startsWith(MARKER)) {
    return stored;
  }
  const payload = stored.slice(MARKER.length);
  if (
    payload.length > 0 &&
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)
  ) {
    throw new ProfileError(
      "apiKey.invalidObf",
      "Obfuscated apiKey is not valid base64",
    );
  }
  try {
    const bytes = reverseBytes(Buffer.from(payload, "base64"));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (err) {
    throw new ProfileError(
      "apiKey.invalidObf",
      "Obfuscated apiKey is not valid base64",
      { cause: err },
    );
  }
}
