import type { GptImgError } from "../errors.js";

type StoreErrorClass = new (code: string, message: string) => GptImgError;

/**
 * Check the `formatVersion` of a parsed store and return the store without it
 * (store-recovery-conventions). It runs before the store's shape check, since
 * this build does not know a newer format's shape.
 *
 * A store that is not a JSON object, or whose `formatVersion` is missing or not
 * a positive integer, throws the store's own `invalidCode`; a newer version
 * throws `<store>.newerFormat`. Each error is the store's own class and names
 * the file. Neither writes anything.
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
  const { formatVersion, ...body } =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new store.ErrorClass(
      store.invalidCode,
      `${store.path} must be a JSON object whose formatVersion is a positive integer`,
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
