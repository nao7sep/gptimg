// SDK failures as the app's own words (error-handling-conventions): an error's
// code or a refusal's code picks catalogue text; the SDK's English message is
// never shown. A refusal's provider reason goes beneath, as the provider's.
import type { ErrorCode, ErrorKind, GptImgErrorData, Refusal, RefusalCode } from "gptimgsdk/types";
import type { AppFailure } from "./api.ts";
import { message, type MessageKey } from "./i18n/translator.ts";

const ERROR_TEXT: Partial<Record<ErrorCode, MessageKey>> = {
  "apiKey.missing": "failure.apiKeyMissing",
  "args.invalid": "failure.invalidRequest",
  "policy.invalid": "failure.invalidRequest",
  "provider.rejected": "failure.providerRejected",
  "provider.unreachable": "failure.unreachable",
  "provider.timeout": "failure.timeout",
  "provider.connectionLost": "failure.connectionLost",
  "provider.serverError": "failure.serverError",
  "provider.rateLimited": "failure.rateLimited",
  "provider.quotaExhausted": "failure.quotaExhausted",
  "provider.invalidResponse": "failure.invalidResponse",
  "provider.truncated": "failure.invalidResponse",
  "image.undecodable": "failure.imageUnreadable",
  "image.unsupportedFormat": "failure.imageUnreadable",
  "image.tooLarge": "failure.imageTooLarge",
  "fs.notFound": "failure.fileMissing",
  "fs.permissionDenied": "failure.filePermission",
  "fs.noSpace": "failure.diskFull",
  "fs.readOnly": "failure.filePermission",
  "memory.exhausted": "failure.memory",
  cancelled: "failure.cancelled",
};

const KIND_TEXT: Record<ErrorKind, MessageKey> = {
  invalid: "failure.invalidRequest",
  unavailable: "failure.unavailable",
  cancelled: "failure.cancelled",
  internal: "failure.internal",
};

const REFUSAL_TEXT: Partial<Record<RefusalCode, MessageKey>> = {
  "provider.moderationBlocked": "failure.moderationBlocked",
  "provider.refused": "failure.refused",
  "provider.contentFiltered": "failure.contentFiltered",
};

/** Retrying cannot help a rejected input; it can help the network or a busy provider. */
const RETRYABLE_KINDS: ReadonlySet<ErrorKind> = new Set(["unavailable", "internal"]);

export function failureFromError(error: GptImgErrorData): AppFailure {
  if (error.code === "refused" && error.details?.refusal) return failureFromRefusal(error.details.refusal);
  // OpenAI answers a wrong or revoked key with 401: name the key, not the request.
  if (error.code === "provider.rejected" && error.details?.status === 401) return { message: message("failure.keyRejected"), retryable: false };
  const key = ERROR_TEXT[error.code] ?? KIND_TEXT[error.kind] ?? "failure.internal";
  return { message: message(key), retryable: RETRYABLE_KINDS.has(error.kind) || error.code === "cancelled" };
}

export function failureFromRefusal(refusal: Refusal): AppFailure {
  const key = REFUSAL_TEXT[refusal.code] ?? "failure.refused";
  // A refusal is never resent as it stands; the user rewords it instead.
  return { message: message(key), ...(refusal.safeReason ? { reason: refusal.safeReason } : {}), retryable: false };
}

/** The utility process ended while the turn ran: the provider may have done the work. */
export function lostWorkerFailure(): AppFailure {
  return { message: message("failure.workerLost"), retryable: true };
}
