import { GptImgError, type ErrorEffect, cancelledError, isCancelled } from "../errors.ts";
import { maskCredentials } from "../events/mask.ts";
import { refuse } from "../refusal.ts";
import { BUDGET_RESEND_POLICY, type NetworkBudgetName } from "./defaults.ts";
import { DROPPED_CODES, UNREACHABLE_CODES, isAbortError, isConnectionError, isTimeout, networkCode } from "./failure.ts";

/** The provider's machine-readable error code, as the OpenAI client exposes it. */
export function providerCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && !/^[A-Z_]+$/.test(code)) return code;
  const nested = (err as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof nested === "string" ? nested : undefined;
}

/** True when a 429 says the account's quota is spent: waiting cannot fix it, so it is never retried. */
export function isQuotaExhausted(err: unknown): boolean {
  return (err as { status?: unknown } | null)?.status === 429 && providerCode(err) === "insufficient_quota";
}

/**
 * The provider's documented reason text, made safe to present: only the error
 * body's `message` field, with credentials masked, control characters removed
 * and whitespace collapsed. Never the raw body.
 */
export function safeProviderReason(err: unknown, credentials: readonly string[]): string | null {
  const message = (err as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === "string" ? safeReasonText(message, credentials) : null;
}

/** A provider's reason string made safe to present beneath a consumer's own copy. */
export function safeReasonText(text: string, credentials: readonly string[]): string | null {
  const cleaned = maskCredentials(text, new Set(credentials))
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * A failed provider or download request as the error naming its observed
 * cause, with `effect` from the evidence: a refused or unresolved connection
 * and a 408/429/503 rejection prove the request never started work (`none`); a
 * timeout, a dropped connection or a server error after a paid request was sent
 * may have been processed and billed (`unknown`). A model download changes
 * nothing remote, so its effect is always `none`. A moderation block is a
 * refusal, not an error.
 */
export function classifyRequestFailure(
  err: unknown,
  budgetName: NetworkBudgetName,
  what: string,
  credentials: readonly string[],
): GptImgError {
  if (isCancelled(err)) return err as GptImgError;
  if (isAbortError(err)) return cancelledError(err, BUDGET_RESEND_POLICY[budgetName] === "unprocessed" ? "unknown" : "none");
  if (err instanceof GptImgError) return err;
  const paid = budgetName !== "modelDownload";
  const maybeSpent: ErrorEffect = paid ? "unknown" : "none";
  const status = (err as { status?: unknown } | null)?.status;
  const code = providerCode(err);
  const requestId = (err as { requestID?: unknown } | null)?.requestID;
  const details = {
    ...(typeof status === "number" && { status }),
    ...(code !== undefined && { providerCode: code }),
    ...(typeof requestId === "string" && { requestId }),
  };
  const message = `${what} failed: ${maskCredentials((err as Error)?.message ?? String(err), new Set(credentials))}`;
  const make = (c: ConstructorParameters<typeof GptImgError>[0], effect: ErrorEffect) =>
    new GptImgError(c, message, { cause: err, effect, details });

  if (typeof status === "number") {
    if (status === 400 && code === "moderation_blocked") {
      refuse("provider.moderationBlocked", `${what} was declined by the provider's moderation.`, {
        safeReason: safeProviderReason(err, credentials),
      });
    }
    if (status === 429) return make(isQuotaExhausted(err) ? "provider.quotaExhausted" : "provider.rateLimited", "none");
    if (status === 408) return make("provider.timeout", "none");
    if (status === 503) return make("provider.serverError", "none");
    if (status >= 500) return make("provider.serverError", maybeSpent);
    if (status >= 400) return make("provider.rejected", "none");
  }
  const net = networkCode(err);
  if (net && UNREACHABLE_CODES.has(net)) return make("provider.unreachable", "none");
  if (isTimeout(err)) return make("provider.timeout", maybeSpent);
  if (net && DROPPED_CODES.has(net)) return make("provider.connectionLost", maybeSpent);
  if (isConnectionError(err)) return make("provider.connectionLost", maybeSpent);
  return new GptImgError("internal.unexpected", message, { cause: err, effect: maybeSpent, details });
}
