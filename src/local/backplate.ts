/**
 * Backplate: synthesize a square PNG containing a centered rounded shape
 * (rect or squircle) filled with a linear gradient, on transparent padding.
 * This is the bottom layer of the icon-composition pipeline:
 *
 *   backplate --size 1024 --from … --to … → layer --base <plate> --top <content>
 *
 * Implementation is SVG → sharp. The SVG gives us cheap antialiasing on the
 * curved edge; no separate feather pass is needed for the v1 default look.
 */

import sharp from "sharp";
import { normalizeHex } from "../color.js";
import { LocalOpError, toAbortError } from "../errors.js";
import type { BackplateShape } from "../types.js";

export const BACKPLATE_DEFAULTS = {
  size: 1024,
  content: 0.8,
  radius: 0.225,
  angle: 135,
  shape: "rect" as BackplateShape,
} as const;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw toAbortError(signal.reason);
}

/**
 * SVG path "d" for a centered square rounded-rectangle.
 * `half` is half the content side; `r` is the corner radius (px).
 */
function rectPathD(cx: number, half: number, r: number): string {
  const L = cx - half;
  const R = cx + half;
  const T = cx - half;
  const B = cx + half;
  // M (top edge start) L (top edge end) A (corner) L (right edge end) A ...
  return [
    `M ${L + r} ${T}`,
    `L ${R - r} ${T}`,
    `A ${r} ${r} 0 0 1 ${R} ${T + r}`,
    `L ${R} ${B - r}`,
    `A ${r} ${r} 0 0 1 ${R - r} ${B}`,
    `L ${L + r} ${B}`,
    `A ${r} ${r} 0 0 1 ${L} ${B - r}`,
    `L ${L} ${T + r}`,
    `A ${r} ${r} 0 0 1 ${L + r} ${T}`,
    `Z`,
  ].join(" ");
}

/**
 * SVG path "d" for a centered square *squircle*: rounded square whose corners
 * are quarter superellipses (|x|^n + |y|^n = r^n with n=4), giving smoother
 * continuous curvature than the circular arcs `rectPathD` emits. This is a
 * close approximation to the macOS app-icon shape, not a pixel-exact match.
 *
 * We sample each corner at `samplesPerCorner` points and emit them as line
 * segments. At 1024px output with 32 samples per corner, the curve is
 * indistinguishable from analytical after sharp's PNG antialiasing.
 */
function squirclePathD(
  cx: number,
  half: number,
  r: number,
  samplesPerCorner = 32,
): string {
  const n = 4;
  const pow = (v: number, e: number): number =>
    Math.sign(v) * Math.pow(Math.abs(v), e);

  const L = cx - half;
  const R = cx + half;
  const T = cx - half;
  const B = cx + half;

  /**
   * Append samples for one corner. The corner is parametrized by t ∈ [0, π/2];
   * at t=0 we're at `center + axis1 * r`, at t=π/2 at `center + axis2 * r`.
   * Caller picks the axes so the corner traces clockwise.
   */
  const cornerSamples = (
    kx: number,
    ky: number,
    a1x: number,
    a1y: number,
    a2x: number,
    a2y: number,
  ): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (let i = 0; i <= samplesPerCorner; i++) {
      const t = (Math.PI / 2) * (i / samplesPerCorner);
      const ex = pow(Math.cos(t), 2 / n) * r;
      const ey = pow(Math.sin(t), 2 / n) * r;
      out.push([kx + ex * a1x + ey * a2x, ky + ex * a1y + ey * a2y]);
    }
    return out;
  };

  const parts: string[] = [];
  parts.push(`M ${L + r} ${T}`);
  parts.push(`L ${R - r} ${T}`);
  // Top-right corner: axis1 = (0,-1) [up = top edge end], axis2 = (+1,0) [right = right edge start].
  for (const [x, y] of cornerSamples(R - r, T + r, 0, -1, 1, 0)) {
    parts.push(`L ${x} ${y}`);
  }
  parts.push(`L ${R} ${B - r}`);
  // Bottom-right corner: axis1 = (1,0), axis2 = (0,1).
  for (const [x, y] of cornerSamples(R - r, B - r, 1, 0, 0, 1)) {
    parts.push(`L ${x} ${y}`);
  }
  parts.push(`L ${L + r} ${B}`);
  // Bottom-left corner: axis1 = (0,1), axis2 = (-1,0).
  for (const [x, y] of cornerSamples(L + r, B - r, 0, 1, -1, 0)) {
    parts.push(`L ${x} ${y}`);
  }
  parts.push(`L ${L} ${T + r}`);
  // Top-left corner: axis1 = (-1,0), axis2 = (0,-1).
  for (const [x, y] of cornerSamples(L + r, T + r, -1, 0, 0, -1)) {
    parts.push(`L ${x} ${y}`);
  }
  parts.push(`Z`);
  return parts.join(" ");
}

/**
 * Convert a CSS-style gradient angle (deg) to SVG objectBoundingBox endpoints.
 *
 * CSS convention: 0deg = bottom→top, 90deg = left→right, 180deg = top→bottom.
 * In screen coords (y axis points down), direction = (sin θ, -cos θ).
 */
function gradientEndpoints(angleDeg: number): {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
} {
  const θ = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(θ);
  const dy = -Math.cos(θ);
  return {
    x1: 0.5 - 0.5 * dx,
    y1: 0.5 - 0.5 * dy,
    x2: 0.5 + 0.5 * dx,
    y2: 0.5 + 0.5 * dy,
  };
}

export interface BackplateRunArgs {
  out: string;
  size?: number;
  content?: number;
  radius?: number;
  from: string;
  to: string;
  angle?: number;
  shape?: BackplateShape;
}

export interface BackplateRunResult {
  output: string;
  size: number;
  content: number;
  radius: number;
  shape: BackplateShape;
  from: string;
  to: string;
  angle: number;
}

/** Build the SVG string the same way `runBackplate` does. Exposed for tests. */
export function buildBackplateSvg(opts: {
  size: number;
  content: number;
  radius: number;
  from: string;
  to: string;
  angle: number;
  shape: BackplateShape;
}): string {
  const cx = opts.size / 2;
  const half = (opts.content * opts.size) / 2;
  // `opts.radius` is constrained to [0, 0.5] by runBackplate, so radius * 2 *
  // half is at most `half` — no further clamping needed.
  const r = opts.radius * 2 * half;
  const d =
    opts.shape === "squircle"
      ? squirclePathD(cx, half, r)
      : rectPathD(cx, half, r);
  const { x1, y1, x2, y2 } = gradientEndpoints(opts.angle);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${opts.size}" height="${opts.size}" viewBox="0 0 ${opts.size} ${opts.size}">` +
    `<defs><linearGradient id="g" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">` +
    `<stop offset="0" stop-color="${opts.from}"/><stop offset="1" stop-color="${opts.to}"/>` +
    `</linearGradient></defs>` +
    `<path d="${d}" fill="url(#g)"/>` +
    `</svg>`
  );
}

export async function runBackplate(
  args: BackplateRunArgs,
  opts: { signal?: AbortSignal | undefined } = {},
): Promise<BackplateRunResult> {
  const { signal } = opts;
  throwIfAborted(signal);

  const size = args.size ?? BACKPLATE_DEFAULTS.size;
  const content = args.content ?? BACKPLATE_DEFAULTS.content;
  const radius = args.radius ?? BACKPLATE_DEFAULTS.radius;
  const angle = args.angle ?? BACKPLATE_DEFAULTS.angle;
  const shape = args.shape ?? BACKPLATE_DEFAULTS.shape;

  if (!Number.isInteger(size) || size <= 0) {
    throw new LocalOpError(
      "args.invalid",
      `backplate: size must be a positive integer; got ${size}.`,
    );
  }
  if (!Number.isFinite(content) || content <= 0 || content > 1) {
    throw new LocalOpError(
      "args.invalid",
      `backplate: content must be in (0, 1]; got ${content}.`,
    );
  }
  if (!Number.isFinite(radius) || radius < 0 || radius > 0.5) {
    throw new LocalOpError(
      "args.invalid",
      `backplate: radius must be in [0, 0.5]; got ${radius}.`,
    );
  }
  if (!Number.isFinite(angle)) {
    throw new LocalOpError(
      "args.invalid",
      `backplate: angle must be a finite number; got ${angle}.`,
    );
  }
  const from = normalizeHex(args.from, "--from");
  const to = normalizeHex(args.to, "--to");

  const svg = buildBackplateSvg({
    size,
    content,
    radius,
    from,
    to,
    angle,
    shape,
  });
  throwIfAborted(signal);

  try {
    await sharp(Buffer.from(svg)).png().toFile(args.out);
  } catch (err) {
    throw new LocalOpError(
      "image.writeFailed",
      `backplate: failed to write ${args.out}: ${(err as Error).message}`,
      { cause: err },
    );
  }

  return { output: args.out, size, content, radius, shape, from, to, angle };
}
