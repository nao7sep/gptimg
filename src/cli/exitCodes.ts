import { GptImgError, isUsageError } from "../errors.js";

export function exitCodeFor(err: unknown): number {
  // Caller mistakes — bad arguments or inputs that fail a precondition — are a
  // usage error regardless of which layer raised them.
  if (isUsageError(err)) return 2;
  if (err instanceof GptImgError) {
    switch (err.errorType) {
      case "profile":
        return 3;
      case "recipe":
        return 3;
      case "provider":
        return 4;
      case "localOp":
        return 5;
    }
  }
  return 1;
}
