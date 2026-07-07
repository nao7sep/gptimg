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

export function toAbortError(err: unknown, fallback = "cancelled"): AbortError {
  if (err instanceof AbortError) return err;
  if (err instanceof Error) {
    return new AbortError(err.message || fallback, { cause: err });
  }
  return new AbortError(typeof err === "string" && err.length > 0 ? err : fallback);
}
