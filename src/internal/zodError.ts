import type { z } from "zod";

/** Flatten a ZodError into a single `path: message; path: message` string. */
export function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
}
