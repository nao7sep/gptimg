/**
 * Pure Swin2SR tile-geometry constants — the model's input contract, with no
 * onnxruntime/sharp dependency. Kept separate from `swin2sr.ts` (which loads
 * the native ONNX runtime) so the argument validator can reference the tile
 * bound without dragging the runtime into every verb's import graph.
 */

export const SWIN2SR_SCALE = 4;

/** Window size: the model requires fed H and W to be multiples of this. */
export const SWIN2SR_WINDOW = 8;

/** Context overlap (source px) kept around each tile and cropped off on merge. */
export const SWIN2SR_OVERLAP = 32;

/** Default max fed model-input edge per pass — the memory knob (~4.4 GB at 256). */
export const SWIN2SR_DEFAULT_TILE = 256;

/** Smallest usable tile: must leave an interior region of at least one window. */
export const SWIN2SR_MIN_TILE = 2 * SWIN2SR_OVERLAP + SWIN2SR_WINDOW;
