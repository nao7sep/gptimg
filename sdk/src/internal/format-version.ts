import { GptImgError } from "../errors.ts";

/** The version an unmarked store reads as: v0.1.0's format, which version 1 kept. */
const UNVERSIONED_FORMAT = 1;

/**
 * Check the `formatVersion` of a parsed store and return the store without it
 * (store-recovery-conventions). It runs before the store's shape check, since
 * this build does not know a newer format's shape.
 *
 * A store without `formatVersion` is the unversioned format gptimg v0.1.0
 * wrote, which is version 1's shape, so it reads as version 1. A store that is not a JSON object, or
 * whose `formatVersion` is present but not a positive integer, throws the
 * store's own `invalidCode`; a newer version throws `<store>.newerFormat`. Each
 * error names the file. Neither writes anything.
 */
export function takeFormatVersion(
  parsed: unknown,
  current: number,
  store: {
    name: "profile" | "sidecar";
    path: string;
    invalidCode: "profile.malformed" | "sidecar.malformed";
  },
): unknown {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GptImgError(store.invalidCode, `${store.path} must be a JSON object`, { subject: store.path });
  }
  const { formatVersion = UNVERSIONED_FORMAT, ...body } = parsed as Record<string, unknown>;
  if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new GptImgError(store.invalidCode, `${store.path} has a formatVersion that is not a positive integer`, {
      subject: store.path,
    });
  }
  if (formatVersion > current) {
    throw new GptImgError(
      store.name === "profile" ? "profile.newerFormat" : "sidecar.newerFormat",
      `${store.path} has format version ${formatVersion}, newer than the ${current} this gptimgsdk reads; ` +
        `it was left unchanged. Use the newer gptimgsdk that wrote it.`,
      { subject: store.path, details: { expected: current, actual: formatVersion } },
    );
  }
  return body;
}
