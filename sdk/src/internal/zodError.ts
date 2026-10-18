import type { z } from "zod";

/** Flatten a ZodError into a single `path: message; path: message` string. */
export function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
}

/** The first issue's field path and message, for an error's typed `details`. */
export function firstZodIssue(err: z.ZodError): { field: string; constraint: string } {
  const issue = err.issues[0];
  return { field: issue?.path.join(".") || "<root>", constraint: issue?.message ?? "invalid" };
}
