/**
 * Grid: tile N images into one comparison sheet. A pure layout primitive — the
 * caller decides *what* to show and in what order; grid only renders the tiling.
 * Each input is contain-fit into a square cell (aspect preserved, transparent
 * padding), so mixed aspect ratios sit centred in equal cells.
 *
 * An input that cannot be read is skipped and reported, never fatal — a review
 * sheet is still useful when one tile is missing. If *no* input is readable the
 * sheet would be empty, which is a caller error, so that throws.
 *
 * Label-free by design: text is a typography concern, not a tiling one, and
 * baking it in would couple this primitive to fonts. Callers that want captions
 * annotate the sheet themselves.
 */

import sharp from "sharp";
import { LocalOpError, toAbortError } from "../errors.js";
import { parseHex } from "../color.js";

export const GRID_DEFAULTS = {
  cell: 256,
  gap: 16,
  background: "transparent",
} as const;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw toAbortError(signal.reason);
}

export interface GridRunArgs {
  inputs: string[];
  out: string;
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
  skipped: string[];
  cols: number;
  rows: number;
  cell: number;
  gap: number;
  width: number;
  height: number;
}

export async function runGrid(
  args: GridRunArgs,
  opts: { signal?: AbortSignal | undefined } = {},
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
  const skipped: string[] = [];
  for (const input of args.inputs) {
    throwIfAborted(signal);
    try {
      const tile = await sharp(input)
        .resize(cell, cell, { fit: "contain", background: transparent })
        .png()
        .toBuffer();
      tiles.push(tile);
    } catch {
      skipped.push(input);
    }
  }

  const placed = tiles.length;
  if (placed === 0) {
    throw new LocalOpError(
      "image.noContent",
      `grid: none of the ${args.inputs.length} input(s) could be read.`,
    );
  }

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

  try {
    await sharp({ create: { width, height, channels: 4, background } })
      .composite(composites)
      .png()
      .toFile(args.out);
  } catch (err) {
    throw new LocalOpError(
      "image.writeFailed",
      `grid: failed to write ${args.out}: ${(err as Error).message}`,
      { cause: err },
    );
  }

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
