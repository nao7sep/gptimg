/**
 * Framecheck: a deterministic, read-only measurement of *how the opaque content
 * sits inside its canvas* — the geometry counterpart to `keycheck`'s colour scan.
 * It transforms nothing; one pass over the alpha channel yields every readout.
 *
 * It answers three geometric questions the stamp/icon workflows ask on every
 * mechanically-placed output, none of which `keycheck` (hue), `trim` (it crops,
 * it does not verify) or the eye (the defect is sub-visible) can answer:
 *
 *  1. Skew / centering — is the subject horizontally (and/or vertically) centred?
 *     `trim` re-pads a uniform margin, so a clean cutout lands symmetric; an
 *     asymmetry means near-invisible stray alpha inflated the any-alpha box on one
 *     side and pushed the *solid* subject off-centre. This is the metal-detector
 *     after `despeckle`: despeckle removes the stray alpha, framecheck confirms it
 *     actually did (at the threshold/minArea the caller chose).
 *  2. Margin-lock — the margins in pixels; the caller divides by the longer edge
 *     to confirm a whole set hit one locked fraction (the "art fills ~91%" rule).
 *  3. Edge-clipping — does the opaque body touch a canvas border (zero margin on
 *     that side)? A clipped subject, or a full-bleed asset the caller expects.
 *
 * Two boxes are reported from the one scan: the any-alpha box (alpha > 0, which
 * includes a soft shadow and feathered edges) and the solid box (alpha ≥
 * threshold, the opaque body). Margins and the verdict are measured on the SOLID
 * box, because the shadow lives in the any-alpha box and would invent a vertical
 * asymmetry; the any-alpha box is reported alongside so a caller can see the
 * halo gap that explains a skew. For a faint-only image (alpha present but none
 * ≥ threshold) the solid box is absent and the any-alpha box is used as the
 * subject; a fully-transparent image is vacuously "centered" (mirroring
 * keycheck's empty-is-clean).
 *
 * Strictly one concern — alpha geometry. It never reads colour (keycheck), never
 * moves or re-pads pixels (trim/layer), and never judges visual balance (vision).
 */

import { toAbortError } from "../errors.js";
import { loadRawRGBA } from "../image/bridge.js";
import type {
  AlphaBBox,
  FramecheckAxes,
  FrameDeltas,
  FrameEdgeContact,
  FrameMargins,
} from "../types.js";

export const FRAMECHECK_DEFAULTS = {
  threshold: 128,
  tolerance: 2,
  axes: "horizontal" as FramecheckAxes,
} as const;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw toAbortError(signal.reason);
}

export interface FramecheckRunArgs {
  in: string;
  threshold?: number;
  tolerance?: number;
  axes?: FramecheckAxes;
}

export interface FramecheckRunResult {
  width: number;
  height: number;
  threshold: number;
  tolerance: number;
  axes: FramecheckAxes;
  /** No pixel ships (the image is fully transparent). */
  empty: boolean;
  /** Tightest box of any shipping pixel (alpha > 0); null when empty. */
  anyBBox: AlphaBBox | null;
  /** Tightest box of the opaque body (alpha ≥ threshold); null when none. */
  solidBBox: AlphaBBox | null;
  /** Margins of the subject box (solid, or any-alpha when no solid pixels); null when empty. */
  margins: FrameMargins | null;
  deltas: FrameDeltas | null;
  edgeContact: FrameEdgeContact | null;
  verdict: "centered" | "offset";
}

export async function runFramecheck(
  args: FramecheckRunArgs,
  opts: { signal?: AbortSignal | undefined } = {},
): Promise<FramecheckRunResult> {
  const { signal } = opts;
  throwIfAborted(signal);

  const threshold = args.threshold ?? FRAMECHECK_DEFAULTS.threshold;
  const tolerance = args.tolerance ?? FRAMECHECK_DEFAULTS.tolerance;
  const axes = args.axes ?? FRAMECHECK_DEFAULTS.axes;

  const { data, width, height } = await loadRawRGBA(args.in);
  throwIfAborted(signal);

  // One scan → two boxes. any: alpha > 0 (incl. shadow/feather); solid: alpha ≥ threshold.
  let ax0 = width, ay0 = height, ax1 = -1, ay1 = -1;
  let sx0 = width, sy0 = height, sx1 = -1, sy1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = data[(y * width + x) * 4 + 3]!;
      if (a > 0) {
        if (x < ax0) ax0 = x;
        if (y < ay0) ay0 = y;
        if (x > ax1) ax1 = x;
        if (y > ay1) ay1 = y;
      }
      if (a >= threshold) {
        if (x < sx0) sx0 = x;
        if (y < sy0) sy0 = y;
        if (x > sx1) sx1 = x;
        if (y > sy1) sy1 = y;
      }
    }
  }

  const anyBBox: AlphaBBox | null =
    ax1 < 0 ? null : { x: ax0, y: ay0, width: ax1 - ax0 + 1, height: ay1 - ay0 + 1 };
  const solidBBox: AlphaBBox | null =
    sx1 < 0 ? null : { x: sx0, y: sy0, width: sx1 - sx0 + 1, height: sy1 - sy0 + 1 };
  const empty = anyBBox === null;

  // Subject box: the opaque body, falling back to any-alpha for a faint-only image.
  const box = solidBBox ?? anyBBox;
  let margins: FrameMargins | null = null;
  let deltas: FrameDeltas | null = null;
  let edgeContact: FrameEdgeContact | null = null;
  let verdict: "centered" | "offset" = "centered"; // empty is vacuously centered

  if (box) {
    const left = box.x;
    const right = width - (box.x + box.width);
    const top = box.y;
    const bottom = height - (box.y + box.height);
    margins = { left, right, top, bottom };
    deltas = { horizontal: Math.abs(left - right), vertical: Math.abs(top - bottom) };
    edgeContact = { left: left === 0, right: right === 0, top: top === 0, bottom: bottom === 0 };
    const hOk = deltas.horizontal <= tolerance;
    const vOk = deltas.vertical <= tolerance;
    const pass = axes === "horizontal" ? hOk : axes === "vertical" ? vOk : hOk && vOk;
    verdict = pass ? "centered" : "offset";
  }

  return {
    width,
    height,
    threshold,
    tolerance,
    axes,
    empty,
    anyBBox,
    solidBBox,
    margins,
    deltas,
    edgeContact,
    verdict,
  };
}
