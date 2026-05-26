/**
 * Compute per-pixel alpha for the chroma output:
 *
 * - Outside the edge band:
 *     - accepted = 1 → α = 0 (background)
 *     - accepted = 0 → α = 255 (subject)
 * - Inside the edge band:
 *     - α = round(255 * smoothstep(d, inner, outer))
 *       (d ≤ inner → 0, d ≥ outer → 255, smooth between)
 */

function smoothstep(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

export function computeAlpha(
  accepted: Uint8Array,
  band: Uint8Array,
  distance: Float32Array,
  innerThreshold: number,
  outerThreshold: number,
): Uint8Array {
  const n = accepted.length;
  const out = new Uint8Array(n);
  const span = Math.max(1e-6, outerThreshold - innerThreshold);
  for (let i = 0; i < n; i++) {
    if (band[i]! === 0) {
      out[i] = accepted[i]! > 0 ? 0 : 255;
      continue;
    }
    const t = (distance[i]! - innerThreshold) / span;
    out[i] = Math.round(255 * smoothstep(t));
  }
  return out;
}
