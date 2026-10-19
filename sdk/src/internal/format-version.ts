import { GptImgError } from "../errors.ts";

/** The version an unmarked sidecar reads as: v0.1.0's format, which version 1 kept. */
const UNVERSIONED_FORMAT = 1;

/**
 * Check the `formatVersion` of a parsed sidecar and return the version with
 * its body without it (store-recovery-conventions). It runs before the
 * shape check, since this build does not know a newer format's shape.
 *
 * A sidecar without `formatVersion` is the unversioned format gptimg v0.1.0
 * wrote, which is version 1's shape, so it reads as version 1. One that is
 * not a JSON object, or whose `formatVersion` is present but not a positive
 * integer (`null` included), is `sidecar.malformed`; a newer version is
 * `sidecar.newerFormat`. Each error names the file. Neither writes anything.
 */
export function takeFormatVersion(
  parsed: unknown,
  current: number,
  subject: string,
): { version: number; body: Record<string, unknown> } {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GptImgError("sidecar.malformed", `${subject} must be a JSON object`, { subject });
  }
  const { formatVersion = UNVERSIONED_FORMAT, ...body } = parsed as Record<string, unknown>;
  if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new GptImgError("sidecar.malformed", `${subject} has a formatVersion that is not a positive integer`, { subject });
  }
  if (formatVersion > current) {
    throw new GptImgError(
      "sidecar.newerFormat",
      `${subject} has format version ${formatVersion}, newer than the ${current} this gptimgsdk reads; ` +
        `it was left unchanged. Use the newer gptimgsdk that wrote it.`,
      { subject, details: { expected: current, actual: formatVersion } },
    );
  }
  return { version: formatVersion, body };
}
