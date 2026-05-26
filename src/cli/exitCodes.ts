import { GptImgError } from "../errors.js";

export function exitCodeFor(err: unknown): number {
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
