import { failedResponseFields } from "../network/retry.ts";
import type { ErrorDiagnostic } from "../types.ts";

/**
 * A failure's diagnostic representation for the event that reports it
 * (error-handling-conventions): its type, structured code, message, stack, the
 * provider's response when it carried one, and its whole cause chain. The
 * logger masks credentials in every event, this included.
 */
export function diagnosticOf(err: unknown, seen = new Set<object>()): ErrorDiagnostic {
  if (!(err instanceof Error)) return { type: typeof err, message: String(err) };
  const code = (err as { code?: unknown }).code;
  const diagnostic: ErrorDiagnostic = {
    type: err.name || err.constructor?.name || "Error",
    message: err.message,
    ...(typeof code === "string" && { code }),
    ...(err.stack !== undefined && { stack: err.stack }),
  };
  const response = failedResponseFields(err);
  if (response) diagnostic.response = response;
  seen.add(err);
  // A cycle in the chain ends it; each cause is recorded once.
  if (err.cause !== undefined && !(err.cause instanceof Object && seen.has(err.cause))) diagnostic.cause = diagnosticOf(err.cause, seen);
  return diagnostic;
}
