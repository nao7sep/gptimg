/**
 * 4-connected connected-component labeling using two-pass union-find.
 * Returns per-component properties needed by the chroma pipeline.
 */

export interface ComponentProps {
  label: number;
  area: number;
  touchesBorder: boolean;
  sumDistance: number;
  meanDistance: number;
}

interface UnionFind {
  parent: number[];
}

function makeUnionFind(initial: number): UnionFind {
  return { parent: Array.from({ length: initial }, (_, i) => i) };
}

function find(uf: UnionFind, x: number): number {
  let r = x;
  while (uf.parent[r] !== r) r = uf.parent[r]!;
  // Path compression.
  let cur = x;
  while (uf.parent[cur] !== r) {
    const next = uf.parent[cur]!;
    uf.parent[cur] = r;
    cur = next;
  }
  return r;
}

function union(uf: UnionFind, a: number, b: number): void {
  const ra = find(uf, a);
  const rb = find(uf, b);
  if (ra !== rb) uf.parent[ra] = rb;
}

/**
 * @param mask Binary mask (0 or 255), length = width*height.
 * @returns labels (Int32Array, 0 = background, 1..N = foreground components)
 *          and `numComponents`.
 */
export function connectedComponents(
  mask: Uint8Array,
  width: number,
  height: number,
): { labels: Int32Array; numComponents: number } {
  const labels = new Int32Array(width * height);
  const uf = makeUnionFind(1);
  uf.parent[0] = 0;
  let nextLabel = 1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (mask[idx]! === 0) continue;
      const upLabel = y > 0 ? labels[(y - 1) * width + x]! : 0;
      const leftLabel = x > 0 ? labels[y * width + (x - 1)]! : 0;
      if (upLabel === 0 && leftLabel === 0) {
        labels[idx] = nextLabel;
        uf.parent.push(nextLabel);
        nextLabel++;
      } else if (upLabel === 0) {
        labels[idx] = leftLabel;
      } else if (leftLabel === 0) {
        labels[idx] = upLabel;
      } else {
        const min = upLabel < leftLabel ? upLabel : leftLabel;
        labels[idx] = min;
        if (upLabel !== leftLabel) union(uf, upLabel, leftLabel);
      }
    }
  }

  // Resolve labels.
  const remap = new Map<number, number>();
  let final = 0;
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]!;
    if (l === 0) continue;
    const root = find(uf, l);
    let m = remap.get(root);
    if (m === undefined) {
      final++;
      m = final;
      remap.set(root, m);
    }
    labels[i] = m;
  }

  return { labels, numComponents: final };
}

export function computeComponentProps(
  labels: Int32Array,
  numComponents: number,
  width: number,
  height: number,
  distance: Float32Array,
): ComponentProps[] {
  const props: ComponentProps[] = [];
  for (let i = 0; i <= numComponents; i++) {
    props.push({
      label: i,
      area: 0,
      touchesBorder: false,
      sumDistance: 0,
      meanDistance: 0,
    });
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const lbl = labels[idx]!;
      if (lbl === 0) continue;
      const p = props[lbl]!;
      p.area++;
      p.sumDistance += distance[idx]!;
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
        p.touchesBorder = true;
      }
    }
  }
  for (let i = 1; i <= numComponents; i++) {
    const p = props[i]!;
    p.meanDistance = p.area > 0 ? p.sumDistance / p.area : 0;
  }
  return props;
}

export function buildLabelMask(
  labels: Int32Array,
  acceptedLabels: Set<number>,
): Uint8Array {
  const out = new Uint8Array(labels.length);
  for (let i = 0; i < labels.length; i++) {
    out[i] = acceptedLabels.has(labels[i]!) ? 255 : 0;
  }
  return out;
}
