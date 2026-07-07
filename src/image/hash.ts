import { createHash } from "node:crypto";

export function hash(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}
