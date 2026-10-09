import type { GptImgError } from "../errors.js";

type StoreErrorClass = new (code: string, message: string) => GptImgError;

/** The version an unmarked store reads as: v0.1.0's format, which version 1 kept. */
const UNVERSIONED_FORMAT = 1;

/**
 * Check the `formatVersion` of a parsed store and return the store without it
 * (store-recovery-conventions). It runs before the store's shape check, since
 * this build does not know a newer format's shape.
 *
 * A store without `formatVersion` is the unversioned format gptimg v0.1.0
 * wrote, which is version 1's shape, so it reads as version 1 and gains the
 * marker only when gptimg next saves it. A store that is not a JSON object, or
 * whose `formatVersion` is present but not a positive integer, throws the
 * store's own `invalidCode`; a newer version throws `<store>.newerFormat`. Each
 * error is the store's own class and names the file. Neither writes anything.
 */
export function takeFormatVersion(
  parsed: unknown,
  current: number,
  store: {
    name: "profile" | "recipe" | "sidecar";
    path: string;
    ErrorClass: StoreErrorClass;
    invalidCode: string;
  },
): unknown {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new store.ErrorClass(store.invalidCode, `${store.path} must be a JSON object`);
  }
  const { formatVersion = UNVERSIONED_FORMAT, ...body } = parsed as Record<string, unknown>;
  if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new store.ErrorClass(
      store.invalidCode,
      `${store.path} has a formatVersion that is not a positive integer`,
    );
  }
  if (formatVersion > current) {
    throw new store.ErrorClass(
      `${store.name}.newerFormat`,
      `${store.path} has format version ${formatVersion}, newer than the ${current} this gptimg reads; ` +
        `it was left unchanged. Use the newer gptimg that wrote it.`,
    );
  }
  return body;
}
