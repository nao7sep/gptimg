export type GptImgErrorType =
  | "profile"
  | "recipe"
  | "provider"
  | "localOp"
  | "abort";

export abstract class GptImgError extends Error {
  abstract readonly errorType: GptImgErrorType;
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = this.constructor.name;
  }
}

export class ProfileError extends GptImgError {
  readonly errorType = "profile" as const;
}

export class RecipeError extends GptImgError {
  readonly errorType = "recipe" as const;
}

export class ProviderError extends GptImgError {
  readonly errorType = "provider" as const;
}

export class LocalOpError extends GptImgError {
  readonly errorType = "localOp" as const;
}

export class AbortError extends GptImgError {
  readonly errorType = "abort" as const;
  constructor(message = "cancelled", options?: { cause?: unknown }) {
    super("cancelled", message, options);
    this.name = "AbortError";
  }
}

/**
 * Codes that represent a caller mistake — an invalid argument value, or an
 * input that fails a precondition the caller controls (an empty image, two
 * inputs whose sizes disagree, an unsupported option value) — as opposed to a
 * runtime, environment, or I/O failure. The CLI maps these to the usage exit
 * code and renders them as a plain one-line message; everything else is a
 * runtime error rendered as JSON. Kept in one place so the exit-code mapping
 * and the error renderer can never disagree about what counts as usage.
 */
const USAGE_ERROR_CODES = new Set<string>([
  "args.invalid",
  "image.noContent",
  "image.sizeMismatch",
  "vision.detailUnsupported",
  "output.mixedExtensions",
]);

export function isUsageError(err: unknown): err is GptImgError {
  return err instanceof GptImgError && USAGE_ERROR_CODES.has(err.code);
}

export function toAbortError(err: unknown, fallback = "cancelled"): AbortError {
  if (err instanceof AbortError) return err;
  if (err instanceof Error) {
    return new AbortError(err.message || fallback, { cause: err });
  }
  return new AbortError(typeof err === "string" && err.length > 0 ? err : fallback);
}
