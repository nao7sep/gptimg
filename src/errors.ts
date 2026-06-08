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
 * input that fails a precondition the caller controls — as opposed to a
 * runtime, environment, or I/O failure. The CLI maps these to the usage exit
 * code and renders them as a plain one-line message; everything else is a
 * runtime error rendered as JSON. Kept in one place so the exit-code mapping
 * and the error renderer can never disagree about what counts as usage.
 *
 * The test is "whose fault?": a bad value, a malformed flag, or a profile/recipe
 * the caller named or wrote are the caller's to fix (usage). A read/permission
 * failure or a model/network/provider failure is the environment's (runtime),
 * even when it touches the same file.
 */
const USAGE_ERROR_CODES = new Set<string>([
  // Invalid argument values / inputs — validated by the SDK (verbs/schemas.ts).
  "args.invalid",
  "image.noContent",
  "image.sizeMismatch",
  "vision.detailUnsupported",
  "output.mixedExtensions",
  // A malformed `--set` expression is a malformed flag.
  "set.invalidExpression",
  // Caller-supplied profile/recipe: a path they named, or JSON/shape they wrote.
  // (Plain read failures stay runtime — see profile.readFailed et al.)
  "provider.unknown",
  "recipe.notFound",
  "recipe.invalidJson",
  "recipe.validationFailed",
  "profile.notFound",
  "profile.invalidJson",
  "profile.validationFailed",
  // Other caller-controlled preconditions: an output collision the caller
  // resolves with --overwrite or a fresh name, a missing API key the caller
  // must supply, an insecure profile file mode the caller can chmod. Not
  // included: output.duplicate, a defensive invariant valid input can't reach.
  "output.exists",
  "output.staleSiblings",
  "apiKey.missing",
  "profile.insecureMode",
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
