import path from "node:path";
import { GptImgError } from "../errors.ts";

/**
 * Every path argument is absolute (sdk-conventions, storage-path-conventions):
 * resolving a relative path is the caller's job, because the SDK reads no
 * working directory. A relative one is an `invalid` call naming the field.
 */
export function assertAbsolutePath(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value)) {
    throw new GptImgError("args.invalid", `${field} must be an absolute path; got ${JSON.stringify(value)}.`, {
      details: { field, constraint: "absolute path" },
    });
  }
}
