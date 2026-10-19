/**
 * The format version of each file gptimgsdk reads or writes for later reading,
 * recorded in the file as `formatVersion` (store-recovery-conventions). Every
 * earlier version listed beside its constant is still read.
 */

/** The `<stem>.json` sidecar beside each paid output. Version 2 adds `writer`; version 1 and unmarked v0.1.0 sidecars read unchanged. */
export const SIDECAR_FORMAT_VERSION = 2;
