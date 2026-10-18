/**
 * The format version of each file gptimgsdk reads or writes for later reading,
 * recorded in the file as `formatVersion` (store-recovery-conventions). Every
 * earlier version listed beside its constant is still read.
 */

/** A profile. Version 2 adds `modelsDir`, `logDir` and `policy`; version 1 and unmarked v0.1.0 profiles read unchanged. */
export const PROFILE_FORMAT_VERSION = 2;

/** The `<stem>.json` sidecar beside each paid output. Version 2 adds `writer`; version 1 and unmarked v0.1.0 sidecars read unchanged. */
export const SIDECAR_FORMAT_VERSION = 2;
