// SDK failures as the app's own words (error-handling-conventions): an error's
// code or a refusal's code picks catalogue text; the SDK's English message is
// never shown. A refusal's provider reason goes beneath, as the provider's.
import { type ErrorCode, type ErrorKind, type GptImgErrorData, type Refusal, type RefusalCode } from "gptimgsdk/types";
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
  "image.notOpaque": "failure.needsFill",
  "model.notInstalled": "failure.upscalerMissing",
  "model.timeout": "failure.downloadFailed",
  "model.connectionLost": "failure.downloadFailed",
  "model.httpStatus": "failure.downloadFailed",
  "model.badRedirect": "failure.downloadFailed",
  "model.insecureUrl": "failure.downloadFailed",
  "model.integrity": "failure.downloadFailed",
  "model.loadFailed": "failure.upscaleFailed",
  "model.runFailed": "failure.upscaleFailed",
  "model.outputShape": "failure.upscaleFailed",
  cancelled: "failure.cancelled",
};

const KIND_TEXT: Record<ErrorKind, MessageKey> = {
  invalid: "failure.invalidRequest",
  unavailable: "failure.unavailable",
  cancelled: "failure.cancelled",
  internal: "failure.internal",
};

const REFUSAL_TEXT: Partial<Record<RefusalCode, MessageKey>> = {
  // The SDK's own refusals about where files go: for the app, the chat could not be saved.
  "output.exists": "failure.sessionWrite",
  "output.caseConflict": "failure.sessionWrite",
  "output.normalizationConflict": "failure.sessionWrite",
  "output.staleSiblings": "failure.sessionWrite",
  "output.busy": "failure.turnRunning",
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
