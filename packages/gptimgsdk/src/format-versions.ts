/**
 * The format version of each file gptimg writes or reads as a store, recorded
 * in the file as `formatVersion` (store-recovery-conventions).
 */

/** `profile.json`. */
export const PROFILE_FORMAT_VERSION = 1;

/** `recipe.json`. */
export const RECIPE_FORMAT_VERSION = 1;

/** The `<stem>.json` sidecar beside each output. */
export const SIDECAR_FORMAT_VERSION = 1;
