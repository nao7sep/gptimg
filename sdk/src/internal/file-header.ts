import { GptImgError } from "../errors.ts";
import type { SidecarWriter } from "../types.ts";

/** The product that owns every file gptimgsdk writes (file-identity-conventions). */
export const OWNER = "gptimg";

/** The identity header a file opens with: what it is, then which build wrote it. */
export function fileHeader(kind: string, version: number, writer: SidecarWriter): { format: { owner: string; kind: string; version: number }; writer: SidecarWriter } {
  return { format: { owner: OWNER, kind, version }, writer };
}

/**
 * Check the header of a parsed file and return its content without the header
 * (file-identity-conventions, store-recovery-conventions). It runs before the
 * shape check, since this build does not know a newer format's shape.
 *
 * `format` must be an object naming this owner and `kind`, with a positive
 * integer `version`. A file that is not a JSON object, or whose `format` is
 * missing, malformed or names another owner or kind, is `sidecar.malformed`;
 * a version above `current` is `sidecar.newerFormat`. `writer` is never read.
 * Each error names the file. Neither writes anything.
 */
export function takeHeader(parsed: unknown, kind: string, current: number, subject: string): Record<string, unknown> {
  if (!isObject(parsed)) {
    throw new GptImgError("sidecar.malformed", `${subject} must be a JSON object`, { subject });
  }
  const { format, writer: _writer, ...body } = parsed;
  if (!isObject(format) || format.owner !== OWNER || format.kind !== kind) {
    throw new GptImgError("sidecar.malformed", `${subject} has no format header for a ${OWNER} ${kind}`, { subject });
  }
  const version = format.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new GptImgError("sidecar.malformed", `${subject} has a format version that is not a positive integer`, { subject });
  }
  if (version > current) {
    throw new GptImgError(
      "sidecar.newerFormat",
      `${subject} has format version ${version}, newer than the ${current} this gptimgsdk reads; ` +
        `it was left unchanged. Use the newer gptimgsdk that wrote it.`,
      { subject, details: { expected: current, actual: version } },
    );
  }
  return body;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
