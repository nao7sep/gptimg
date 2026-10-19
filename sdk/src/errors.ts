import type { Refusal } from "./refusal.ts";

/**
 * The SDK's one error type (sdk-conventions, *Errors*). An error means the
 * operation could not run; a decision not to proceed is a refusal result, not
 * an error (see `REFUSAL_CODES` in `refusal.ts`). Consumers branch on the
 * fields, never on a class: `code` names the observed cause, `kind` says what a
 * consumer can do without knowing every code, and `effect` says, from the
 * evidence held where the failure occurred, whether anything may have changed
 * or been spent.
 */

export const ERROR_KINDS = ["invalid", "unavailable", "cancelled", "internal"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

export const ERROR_EFFECTS = ["none", "unknown"] as const;
export type ErrorEffect = (typeof ERROR_EFFECTS)[number];

/**
 * Every error code and its kind, declared once. A guard test fails on a code
 * thrown anywhere in `src/` that is not a key here.
 */
export const ERROR_CODES = {
  // The call or its inputs are wrong: fix them, do not retry.
  "args.invalid": "invalid",
  "profile.malformed": "invalid",
  "profile.newerFormat": "invalid",
  "profile.insecureMode": "invalid",
  "apiKey.missing": "invalid",
  "apiKey.malformed": "invalid",
  "policy.invalid": "invalid",
  // A refusal a script chose to treat as a failure, through `completed()`; the
  // refusal itself, with its own code, is in `details.refusal`.
  refused: "invalid",
  "image.undecodable": "invalid",
  "image.unsupportedFormat": "invalid",
  "image.noContent": "invalid",
  "image.notOpaque": "invalid",
  "image.sizeMismatch": "invalid",
  "image.tooLarge": "invalid",
  "sidecar.malformed": "invalid",
  "sidecar.newerFormat": "invalid",
  "output.duplicate": "invalid",
  "provider.rejected": "invalid",

  // The world did not cooperate: it may succeed later.
  "fs.notFound": "unavailable",
  "fs.permissionDenied": "unavailable",
  "fs.noSpace": "unavailable",
  "fs.readOnly": "unavailable",
  "fs.busy": "unavailable",
  "fs.tooManyOpenFiles": "unavailable",
  "fs.failed": "unavailable",
  "provider.unreachable": "unavailable",
  "provider.timeout": "unavailable",
  "provider.connectionLost": "unavailable",
  "provider.serverError": "unavailable",
  "provider.rateLimited": "unavailable",
  "provider.quotaExhausted": "unavailable",
  "provider.invalidResponse": "unavailable",
  "provider.truncated": "unavailable",
  "model.notInstalled": "unavailable",
  "model.timeout": "unavailable",
  "model.connectionLost": "unavailable",
  "model.httpStatus": "unavailable",
  "model.badRedirect": "unavailable",
  "model.insecureUrl": "unavailable",
  "model.integrity": "unavailable",
  "model.loadFailed": "unavailable",
  "memory.exhausted": "unavailable",

  // Requested, never a failure.
  cancelled: "cancelled",

  // The SDK broke its own invariant, or a failure escaped classification.
  "model.runFailed": "internal",
  "model.outputShape": "internal",
  "internal.invariant": "internal",
  "internal.unexpected": "internal",
} as const satisfies Record<string, ErrorKind>;

export type ErrorCode = keyof typeof ERROR_CODES;

/**
 * Fields specific to a code. Each is present only where its code sets it:
 * `field`/`constraint` on `args.invalid`; `section`/`field` on `policy.invalid`;
 * `status`/`providerCode`/`requestId` on provider codes and `model.httpStatus`;
 * `expected`/`actual` on `model.integrity`; `errno`/`syscall` on `fs.*`; `mode`
 * on `profile.insecureMode`; `variable` on `apiKey.missing` and
 * `profile.malformed` when a named environment variable is involved; `refusal`
 * on `refused`.
 */
export interface ErrorDetails {
  field?: string;
  constraint?: string;
  section?: string;
  status?: number;
  providerCode?: string;
  requestId?: string;
  expected?: string | number;
  actual?: string | number;
  errno?: string;
  syscall?: string;
  mode?: string;
  variable?: string;
  refusal?: Refusal;
}

/** A serialized cause: enough to diagnose, nothing that needs its original realm. */
export interface SerializedCause {
  name: string;
  message: string;
  code?: string;
  cause?: SerializedCause;
}

/** The plain-object form of a `GptImgError`, as `toJSON()` produces and other processes receive. */
export interface GptImgErrorData {
  name: "GptImgError";
  code: ErrorCode;
  kind: ErrorKind;
  effect: ErrorEffect;
  message: string;
  subject?: string;
  details?: ErrorDetails;
  cause?: SerializedCause;
}

export interface GptImgErrorOptions {
  cause?: unknown;
  /** Default `none`; set `unknown` only from evidence that a write began or a paid request may have landed. */
  effect?: ErrorEffect;
  subject?: string;
  details?: ErrorDetails;
}

export class GptImgError extends Error {
  readonly code: ErrorCode;
  readonly kind: ErrorKind;
  readonly effect: ErrorEffect;
  readonly subject: string | undefined;
  readonly details: ErrorDetails | undefined;

  constructor(code: ErrorCode, message: string, options: GptImgErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GptImgError";
    this.code = code;
    this.kind = ERROR_CODES[code];
    this.effect = options.effect ?? "none";
    this.subject = options.subject;
    this.details = options.details;
  }

  /** The same error as a copy with a different effect, for an owner that holds later evidence. */
  withEffect(effect: ErrorEffect): GptImgError {
    if (effect === this.effect) return this;
    return new GptImgError(this.code, this.message, {
      cause: this.cause,
      effect,
      subject: this.subject,
      details: this.details,
    });
  }

  toJSON(): GptImgErrorData {
    return {
      name: "GptImgError",
      code: this.code,
      kind: this.kind,
      effect: this.effect,
      message: this.message,
      ...(this.subject !== undefined && { subject: this.subject }),
      ...(this.details !== undefined && { details: this.details }),
      ...(this.cause !== undefined && { cause: serializeCause(this.cause) }),
    };
  }
}

function serializeCause(cause: unknown, depth = 0): SerializedCause {
  if (!(cause instanceof Error)) return { name: typeof cause, message: String(cause) };
  const code = (cause as { code?: unknown }).code;
  return {
    name: cause.name || "Error",
    message: cause.message,
    ...(typeof code === "string" && { code }),
    ...(cause.cause !== undefined && depth < 4 && { cause: serializeCause(cause.cause, depth + 1) }),
  };
}

/** Recognizes a `GptImgError` or its serialized form, from this realm or another process. */
export function isGptImgErrorData(value: unknown): value is GptImgErrorData {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.name === "GptImgError" &&
    typeof v.code === "string" &&
    Object.hasOwn(ERROR_CODES, v.code) &&
    v.kind === ERROR_CODES[v.code as ErrorCode] &&
    (v.effect === "none" || v.effect === "unknown") &&
    typeof v.message === "string"
  );
}

/** The `cancelled` error for a signal's reason, keeping a cancellation error unchanged. */
export function cancelledError(reason: unknown, effect: ErrorEffect = "none"): GptImgError {
  if (reason instanceof GptImgError && reason.code === "cancelled") return reason.withEffect(effect);
  if (reason instanceof Error) {
    return new GptImgError("cancelled", reason.message || "cancelled", { cause: reason, effect });
  }
  return new GptImgError("cancelled", typeof reason === "string" && reason.length > 0 ? reason : "cancelled", {
    effect,
  });
}

/** Whether `err` is this SDK's cancellation. */
export function isCancelled(err: unknown): boolean {
  return err instanceof GptImgError && err.code === "cancelled";
}

/** Throws the signal's abort as a `cancelled` error when it has fired; a no-op otherwise. */
export function throwIfAborted(signal: AbortSignal | undefined, effect: ErrorEffect = "none"): void {
  if (signal?.aborted) throw cancelledError(signal.reason, effect);
}

const FS_CODES: Record<string, ErrorCode> = {
  ENOENT: "fs.notFound",
  ENOTDIR: "fs.notFound",
  EACCES: "fs.permissionDenied",
  EPERM: "fs.permissionDenied",
  ENOSPC: "fs.noSpace",
  EDQUOT: "fs.noSpace",
  EROFS: "fs.readOnly",
  EBUSY: "fs.busy",
  ETXTBSY: "fs.busy",
  EMFILE: "fs.tooManyOpenFiles",
  ENFILE: "fs.tooManyOpenFiles",
};

/**
 * A filesystem failure as the error naming what the system reported. `what`
 * says what the SDK was doing, for the diagnostic message only; the code is
 * the cause.
 */
export function fsError(
  err: unknown,
  what: string,
  subject: string,
  effect: ErrorEffect = "none",
): GptImgError {
  if (err instanceof GptImgError) return err.effect === effect || effect === "none" ? err : err.withEffect(effect);
  const e = err as NodeJS.ErrnoException;
  const errno = typeof e?.code === "string" ? e.code : undefined;
  const code = (errno && FS_CODES[errno]) || "fs.failed";
  return new GptImgError(code, `${what} ${subject}: ${(err as Error)?.message ?? String(err)}`, {
    cause: err,
    effect,
    subject,
    details: {
      ...(errno !== undefined && { errno }),
      ...(typeof e?.syscall === "string" && { syscall: e.syscall }),
    },
  });
}

/**
 * A failure inside an image pipeline (sharp, encoders) after a write may have
 * begun: typed failures and refusals pass through, a filesystem failure names
 * its cause, and anything else escaped classification (`internal.unexpected`;
 * an allocation failure is contained as `memory.exhausted` at the verb
 * boundary).
 */
export function processingError(err: unknown, what: string, subject: string, effect: ErrorEffect = "unknown"): Error {
  if (err instanceof GptImgError || (err as { name?: unknown } | null)?.name === "RefusalSignal") return err as Error;
  const errno = (err as NodeJS.ErrnoException | null)?.code;
  if (typeof errno === "string" && /^E[A-Z]+$/.test(errno)) return fsError(err, what, subject, effect);
  return new GptImgError("internal.unexpected", `${what} ${subject}: ${(err as Error)?.message ?? String(err)}`, {
    cause: err,
    subject,
    effect,
  });
}
