/**
 * Grid: tile N images into one comparison sheet. A pure layout primitive — the
 * caller decides *what* to show and in what order; grid only renders the tiling.
 * Each input is contain-fit into a square cell (aspect preserved, transparent
 * padding), so mixed aspect ratios sit centred in equal cells.
 *
 * An input that cannot be read is skipped and reported, never fatal — a review
 * sheet is still useful when one tile is missing. If *no* input is readable
 * there is no sheet, so the first input's own error is thrown.
 *
 * Label-free by design: text is a typography concern, not a tiling one, and
 * baking it in would couple this primitive to fonts. Callers that want captions
 * annotate the sheet themselves.
 */

import sharp from "../image/sharp.ts";
import { GptImgError, throwIfAborted } from "../errors.ts";
import { inputImageError, writeImageFile } from "../image/bridge.ts";
import type { Logger } from "../events/index.ts";
import { parseHex } from "../color.ts";
import type { EncodingArgs, GridSkip } from "../types.ts";


export const GRID_DEFAULTS = {
  cell: 256,
  gap: 16,
  background: "transparent",
} as const;

export interface GridRunArgs extends EncodingArgs {
  inputs: string[];
  out: string;
  /** Replace an existing file at `out`; otherwise publication is no-clobber. */
  overwrite?: boolean;
  cols?: number;
  cell?: number;
  gap?: number;
  /** "transparent" | "#rrggbb". */
  background?: string;
}

export interface GridRunResult {
  output: string;
  count: number;
  placed: number;
  skipped: GridSkip[];
  cols: number;
  rows: number;
  cell: number;
  gap: number;
  width: number;
  height: number;
}

export async function runGrid(
  args: GridRunArgs,
  opts: { signal?: AbortSignal | undefined; logger?: Logger } = {},
): Promise<GridRunResult> {
  const { signal } = opts;
  throwIfAborted(signal);

  const cell = args.cell ?? GRID_DEFAULTS.cell;
  const gap = args.gap ?? GRID_DEFAULTS.gap;
  const bgSpec = args.background ?? GRID_DEFAULTS.background;
  const background =
    bgSpec === "transparent"
      ? { r: 0, g: 0, b: 0, alpha: 0 }
      : (() => {
          const [r, g, b] = parseHex(bgSpec);
          return { r, g, b, alpha: 1 };
        })();
  const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

  // Render each input into a cell-sized tile. A read/decode failure is the one
  // case we tolerate: record it and carry on.
  const tiles: Buffer[] = [];
  const skipped: GridSkip[] = [];
  let firstFailure: GptImgError | undefined;
  let read = 0;
  for (const input of args.inputs) {
    throwIfAborted(signal);
    try {
      const tile = await sharp(input)
        .resize(cell, cell, { fit: "contain", background: transparent })
        .png()
        .toBuffer();
      tiles.push(tile);
    } catch (err) {
      const reason = inputImageError(err, "grid: failed to read", input) as GptImgError;
      firstFailure ??= reason;
      skipped.push({ input, code: reason.code, effect: "none", message: reason.message });
    }
    read += 1;
    opts.logger?.progress("read", read, args.inputs.length, "inputs");
    // Decode failures are tolerated; cancellation after either outcome is not.
    throwIfAborted(signal);
  }

  const placed = tiles.length;
  // With nothing to place there is no sheet: the first input's own error says why.
  if (placed === 0 && firstFailure !== undefined) throw firstFailure;

  const cols = args.cols ?? Math.ceil(Math.sqrt(placed));
  const rows = Math.ceil(placed / cols);
  const width = cols * cell + (cols + 1) * gap;
  const height = rows * cell + (rows + 1) * gap;

  const composites = tiles.map((input, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return {
      input,
      left: gap + col * (cell + gap),
      top: gap + row * (cell + gap),
    };
  });

  await writeImageFile({ path: args.out, overwrite: args.overwrite }, "grid", args, () =>
    sharp({ create: { width, height, channels: 4, background } }).composite(composites),
  );

  return {
    output: args.out,
    count: args.inputs.length,
    placed,
    skipped,
    cols,
    rows,
    cell,
    gap,
    width,
    height,
  };
}
