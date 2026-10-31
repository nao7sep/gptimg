import { GptImgError } from "../errors.ts";

/**
 * Check the `formatVersion` of a parsed sidecar and return its body without
 * it (store-recovery-conventions). It runs before the shape check, since this
 * build does not know a newer format's shape.
 *
 * Only the current format reads. One that is not a JSON object, or whose
 * `formatVersion` is absent or not a positive integer (`null` included), is
 * `sidecar.malformed`; a newer version is `sidecar.newerFormat`. Each error names the file. Neither writes anything.
 */
export function takeFormatVersion(parsed: unknown, current: number, subject: string): Record<string, unknown> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GptImgError("sidecar.malformed", `${subject} must be a JSON object`, { subject });
  }
  const { formatVersion, ...body } = parsed as Record<string, unknown>;
  if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new GptImgError("sidecar.malformed", `${subject} has no formatVersion that is a positive integer`, { subject });
  }
  if (formatVersion > current) {
    throw new GptImgError(
      "sidecar.newerFormat",
      `${subject} has format version ${formatVersion}, newer than the ${current} this gptimgsdk reads; ` +
        `it was left unchanged. Use the newer gptimgsdk that wrote it.`,
      { subject, details: { expected: current, actual: formatVersion } },
    );
  }
  return body;
}
