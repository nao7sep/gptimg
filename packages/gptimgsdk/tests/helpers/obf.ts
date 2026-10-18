/** The api-key-storage-conventions' `obf:` encoding, as an app writing a profile applies it. */
export function obfuscate(raw: string): string {
  return "obf:" + Buffer.from(raw, "utf-8").reverse().toString("base64");
}
