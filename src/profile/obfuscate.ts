import { ProfileError } from "../errors.js";

const MARKER = "obf:";

function reverseString(s: string): string {
  return Array.from(s).reverse().join("");
}

export function obfuscate(raw: string): string {
  const reversed = reverseString(raw);
  const encoded = Buffer.from(reversed, "utf-8").toString("base64");
  return MARKER + encoded;
}

export function deobfuscate(stored: string): string {
  if (!stored.startsWith(MARKER)) {
    return stored;
  }
  const payload = stored.slice(MARKER.length);
  let decoded: string;
  try {
    decoded = Buffer.from(payload, "base64").toString("utf-8");
  } catch (err) {
    throw new ProfileError(
      "apiKey.invalidObf",
      "Obfuscated apiKey is not valid base64",
      { cause: err },
    );
  }
  return reverseString(decoded);
}

export function isObfuscated(stored: string): boolean {
  return stored.startsWith(MARKER);
}
