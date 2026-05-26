import { GptImgError } from "../errors.js";

function isTTY(): boolean {
  return Boolean(process.stdout.isTTY);
}

export function emit(result: unknown): void {
  const indent = isTTY() ? 2 : 0;
  process.stdout.write(JSON.stringify(result, null, indent) + "\n");
}

export function emitError(err: unknown): void {
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
