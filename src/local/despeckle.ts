/**
 * Despeckle: denoise an RGBA cutout's alpha matte. Chroma keying (and bleed
 * removal) leave two kinds of junk in alpha that `compose` doesn't clear — a
 * faint sub-visible wash, and isolated speckles out toward the canvas edge —
 * and because `trim` keys off *any* non-zero alpha, that junk both ships as
 * faint cruft and inflates the bounding box (shoving the subject off-centre).
 *
 * One coherent operation, two knobs:
 *   1. Floor — zero every alpha below `threshold` (also the "present" level for
 *      step 2). A pure floor is just `minArea = 0`.
 *   2. Connected-component filter — over the alpha ≥ threshold pixels, find
 *      components (4/8-connectivity) and drop any whose pixel area < `minArea`,
 *      keeping ALL larger components (so multi-piece subjects — a rainbow's two
 *      clouds, a cherry pair — survive). `keep: "largest"` instead keeps only
 *      the single biggest component.
 *
 * It only ever zeros alpha — never paints or fills — so the subject and any
 * interior holes are untouched, and it is idempotent. A fully-transparent input
 * is a graceful no-op (written back unchanged), not an error.
 */

import { toAbortError } from "../errors.js";
import { loadRawRGBA, writeRGBA } from "../image/bridge.js";
import { computeAlphaBBox } from "./trim.js";
import type { AlphaBBox, DespeckleKeep } from "../types.js";

export const DESPECKLE_DEFAULTS = {
  threshold: 5,
  minArea: 0,
  connectivity: 8,
  keep: "all",
} as const;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw toAbortError(signal.reason);
}

export interface DespeckleRunArgs {
  in: string;
  out: string;
  threshold?: number;
  minArea?: number;
  connectivity?: number;
  keep?: DespeckleKeep;
}

export interface DespeckleRunResult {
  output: string;
  threshold: number;
  minArea: number;
  connectivity: number;
  keep: DespeckleKeep;
  flooredPixels: number;
  components: number;
  removedComponents: number;
  removedPixels: number;
  bboxBefore: AlphaBBox | null;
  bboxAfter: AlphaBBox | null;
  width: number;
  height: number;
}

// 8-connectivity neighbour offsets; the first four are the 4-connectivity set.
const NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [-1, 0],
  [1, 0],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

export async function runDespeckle(
  args: DespeckleRunArgs,
  opts: { signal?: AbortSignal | undefined } = {},
): Promise<DespeckleRunResult> {
  const { signal } = opts;
  throwIfAborted(signal);

  const threshold = args.threshold ?? DESPECKLE_DEFAULTS.threshold;
  const minArea = args.minArea ?? DESPECKLE_DEFAULTS.minArea;
  const connectivity = args.connectivity ?? DESPECKLE_DEFAULTS.connectivity;
  const keep: DespeckleKeep = args.keep ?? DESPECKLE_DEFAULTS.keep;
  const neighborCount = connectivity === 8 ? 8 : 4;

  const { data, width, height } = await loadRawRGBA(args.in);
  throwIfAborted(signal);
  const n = width * height;

  const bboxBefore = computeAlphaBBox(data, width, height);

  // Step 1 — floor. Zero 0 < alpha < threshold; mark survivors "present" for the
  // component pass. `presentLevel` is max(threshold, 1) so threshold=0 ("no
  // floor") still treats only alpha > 0 as present, never the fully-transparent
  // background.
  const presentLevel = threshold < 1 ? 1 : threshold;
  const present = new Uint8Array(n);
  let flooredPixels = 0;
  for (let p = 0; p < n; p++) {
    const a = data[p * 4 + 3]!;
    if (a >= presentLevel) {
      present[p] = 1;
    } else if (a > 0) {
      data[p * 4 + 3] = 0;
      flooredPixels++;
    }
  }

  // Step 2 — label connected components of "present" pixels (explicit stack, no
  // recursion; linear in pixels) and record each component's pixel area.
  const labels = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  let components = 0;
  for (let start = 0; start < n; start++) {
    if (present[start] === 0 || labels[start] !== -1) continue;
    const id = components;
    labels[start] = id;
    stack.length = 0;
    stack.push(start);
    let size = 0;
    while (stack.length > 0) {
      const p = stack.pop()!;
      size++;
      const px = p % width;
      const py = (p / width) | 0;
      for (let k = 0; k < neighborCount; k++) {
        const nx = px + NEIGHBORS[k]![0];
        const ny = py + NEIGHBORS[k]![1];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const np = ny * width + nx;
        if (present[np] === 1 && labels[np] === -1) {
          labels[np] = id;
          stack.push(np);
        }
      }
    }
    sizes.push(size);
    components++;
  }

  // Decide which components to drop.
  const removeComp = new Uint8Array(components);
  let removedComponents = 0;
  if (keep === "largest") {
    if (components > 0) {
      let largest = 0;
      for (let c = 1; c < components; c++) {
        if (sizes[c]! > sizes[largest]!) largest = c;
      }
      for (let c = 0; c < components; c++) {
        if (c !== largest) {
          removeComp[c] = 1;
          removedComponents++;
        }
      }
    }
  } else {
    for (let c = 0; c < components; c++) {
      if (sizes[c]! < minArea) {
        removeComp[c] = 1;
        removedComponents++;
      }
    }
  }

  // Zero alpha for pixels in dropped components.
  let removedPixels = 0;
  if (removedComponents > 0) {
    for (let p = 0; p < n; p++) {
      const c = labels[p]!;
      if (c !== -1 && removeComp[c] === 1) {
        data[p * 4 + 3] = 0;
        removedPixels++;
      }
    }
  }

  const bboxAfter = computeAlphaBBox(data, width, height);

  throwIfAborted(signal);
  await writeRGBA(data, width, height, args.out);

  return {
    output: args.out,
    threshold,
    minArea,
    connectivity,
    keep,
    flooredPixels,
    components,
    removedComponents,
    removedPixels,
    bboxBefore,
    bboxAfter,
    width,
    height,
  };
}
