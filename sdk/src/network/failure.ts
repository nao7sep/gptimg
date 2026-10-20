/**
 * What a failed request's error says about the network, shared by the retry
 * loop (may it be resent?) and the classifier (which code names it?), so the
 * two never disagree about the same failure.
 */

import { isCancelled } from "../errors.ts";

/** True for a cancellation: the SDK's own, or an abort surfaced by fetch or the OpenAI client. */
export function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (isCancelled(err) || err.name === "AbortError") return true;
  const code = (err as { code?: string }).code;
  return code === "ABORT_ERR" || code === "ERR_ABORTED";
}


/** System codes that prove the request never reached the provider: it could not be resolved or connected. */
export const UNREACHABLE_CODES: ReadonlySet<string> = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);

/** System codes for a connection that dropped after the request may have been sent. */
export const DROPPED_CODES: ReadonlySet<string> = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "ECONNABORTED"]);

/**
 * The first system code on the error or its `cause` chain. The OpenAI client
 * wraps a fetch failure in APIConnectionError, and fetch wraps the socket
 * error in a TypeError, so the code sits two causes deep. Only upper-case
 * codes count, so a provider's own code (`insufficient_quota`) is not one.
 */
export function networkCode(err: unknown): string | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur && typeof cur === "object"; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z_]+$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** The error's own name and its class's, since the OpenAI client's errors keep the generic name. */
export function errorNames(err: unknown): string[] {
  if (!err || typeof err !== "object") return [];
  return [(err as { name?: unknown }).name, err.constructor?.name].filter((n): n is string => typeof n === "string");
}

/** A request that timed out, by the error's class or a system code anywhere on its cause chain. */
export function isTimeout(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur && typeof cur === "object"; depth++) {
    const names = errorNames(cur);
    if (names.includes("TimeoutError") || names.includes("APIConnectionTimeoutError")) return true;
    if ((cur as { code?: unknown }).code === "ETIMEDOUT") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** The OpenAI client's connection failure, which carries no HTTP status. */
export function isConnectionError(err: unknown): boolean {
  const names = errorNames(err);
  return names.includes("APIConnectionError") || names.includes("APIConnectionTimeoutError");
}
