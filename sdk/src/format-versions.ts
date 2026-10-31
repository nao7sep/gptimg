/**
 * The format version of each file gptimgsdk reads or writes for later reading,
 * recorded in the file as `formatVersion` (store-recovery-conventions). Only
 * the current version reads.
 */

/** The `<stem>.json` sidecar beside each paid output. It names its `kind` and its `writer`. */
export const SIDECAR_FORMAT_VERSION = 2;
