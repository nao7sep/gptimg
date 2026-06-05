import { GptImgError, isUsageError } from "../errors.js";

function isTTY(): boolean {
  return Boolean(process.stdout.isTTY);
}

export function emit(result: unknown): void {
  const indent = isTTY() ? 2 : 0;
  process.stdout.write(JSON.stringify(result, null, indent) + "\n");
}

export function emitError(err: unknown): void {
  // Caller mistakes read as usage errors to a human: render them as a plain
  // one-line message (commander's style), not the structured envelope.
  if (isUsageError(err)) {
    process.stderr.write(`error: ${err.message}\n`);
    return;
  }
  const indent = process.stderr.isTTY ? 2 : 0;
  const payload =
    err instanceof GptImgError
      ? {
          error: {
            type: err.errorType,
            code: err.code,
            message: err.message,
          },
        }
      : {
          error: {
            type: "unknown",
            code: "unknown",
            message: err instanceof Error ? err.message : String(err),
          },
        };
  process.stderr.write(JSON.stringify(payload, null, indent) + "\n");
}
