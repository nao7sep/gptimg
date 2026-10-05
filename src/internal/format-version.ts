import type { GptImgError } from "../errors.js";

type StoreErrorClass = new (code: string, message: string) => GptImgError;

/**
 * Check the `formatVersion` of a parsed store and return the store without it
 * (store-recovery-conventions). It runs before the store's shape check, since
 * this build does not know a newer format's shape; a value that is not a JSON
 * object is returned unchanged for that shape check to reject.
 *
 * Throws `<store>.newerFormat` for a version newer than `current` and
 * `<store>.invalidFormatVersion` for one that is not a positive integer, each
 * as the store's own error class and naming the file. Neither writes anything.
 */
export function takeFormatVersion(
  parsed: unknown,
  current: number,
  store: { name: "profile" | "recipe" | "sidecar"; path: string; ErrorClass: StoreErrorClass },
): unknown {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return parsed;
  const { formatVersion, ...body } = parsed as Record<string, unknown>;
  if (formatVersion === undefined) return body;
  if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new store.ErrorClass(
      `${store.name}.invalidFormatVersion`,
      `formatVersion in ${store.path} must be a positive integer, not ${JSON.stringify(formatVersion)}`,
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
