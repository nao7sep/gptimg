import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";

export interface WindowedItem { id: string; estimatedHeight: number }

function itemAt(offsets: readonly number[], position: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle]! <= position) low = middle;
    else high = middle - 1;
  }
  return Math.min(low, offsets.length - 2);
}

/** Geometry is retained by id; only the viewport and one viewport either side mount. */
export function useWindowedItems(items: readonly WindowedItem[], scroller: RefObject<HTMLDivElement | null>, resetKey: string, uniform = false) {
  const cache = useRef({ key: resetKey, heights: new Map<string, number>(), uniformHeight: 0 });
  if (cache.current.key !== resetKey) cache.current = { key: resetKey, heights: new Map(), uniformHeight: 0 };
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState({ top: 0, height: 0 });
  const startRef = useRef<HTMLDivElement>(null);
  const origin = useRef(0);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const observer = useRef<ResizeObserver | null>(null);
  const callbacks = useRef(new Map<string, (node: HTMLDivElement | null) => void>());
  const offsets = useMemo(() => {
    const result = [0];
    for (const item of items) result.push(result.at(-1)! + (uniform && cache.current.uniformHeight || cache.current.heights.get(item.id) || item.estimatedHeight));
    return result;
  }, [items, revision, resetKey, uniform]);
  useLayoutEffect(() => {
    const ids = new Set(items.map((item) => item.id));
    for (const id of cache.current.heights.keys()) if (!ids.has(id)) cache.current.heights.delete(id);
    for (const id of callbacks.current.keys()) if (!ids.has(id)) callbacks.current.delete(id);
  }, [items]);
  const latest = useRef({ items, offsets, uniform });
  latest.current = { items, offsets, uniform };

  const refresh = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setView((previous) => previous.top === el.scrollTop && previous.height === el.clientHeight ? previous : { top: el.scrollTop, height: el.clientHeight });
  }, [scroller]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const previousAnchor = el.style.overflowAnchor;
    el.style.overflowAnchor = "none";
    const measure = () => {
      if (startRef.current) origin.current = startRef.current.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      refresh();
    };
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    const rows = new ResizeObserver((entries) => {
      const { items: current, offsets: before, uniform: fixed } = latest.current;
      const firstVisible = Math.max(0, itemAt(before, el.scrollTop - origin.current));
      let delta = 0;
      let changed = false;
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.windowedId;
        const index = current.findIndex((item) => item.id === id);
        const height = entry.target.getBoundingClientRect().height;
        if (index < 0 || height <= 0) continue;
        const old = before[index + 1]! - before[index]!;
        if (fixed) {
          if (cache.current.uniformHeight === height) continue;
          delta += (height - old) * firstVisible;
          cache.current.uniformHeight = height;
          changed = true;
          break;
        }
        if (cache.current.heights.get(id!) === height) continue;
        cache.current.heights.set(id!, height);
        if (index < firstVisible) delta += height - old;
        changed = true;
      }
      if (changed) {
        el.scrollTop += delta;
        setRevision((value) => value + 1);
        refresh();
      }
    });
    observer.current = rows;
    for (const node of nodes.current.values()) rows.observe(node);
    el.addEventListener("scroll", refresh);
    measure();
    return () => {
      rows.disconnect();
      resize.disconnect();
      observer.current = null;
      el.removeEventListener("scroll", refresh);
      el.style.overflowAnchor = previousAnchor;
    };
  }, [scroller, refresh, resetKey]);

  const measureRef = useCallback((id: string) => {
    let callback = callbacks.current.get(id);
    if (!callback) {
      callback = (node) => {
        const old = nodes.current.get(id);
        if (old) observer.current?.unobserve(old);
        if (node) {
          node.dataset.windowedId = id;
          nodes.current.set(id, node);
          observer.current?.observe(node);
        } else nodes.current.delete(id);
      };
      callbacks.current.set(id, callback);
    }
    return callback;
  }, []);

  const scrollToIndex = useCallback((index: number) => {
    const el = scroller.current;
    const { offsets: positions, items: current } = latest.current;
    if (!el || index < 0 || index >= current.length) return;
    const top = origin.current + positions[index]!;
    const bottom = origin.current + positions[index + 1]!;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    refresh();
  }, [scroller, refresh]);

  const height = Math.max(1, view.height);
  const top = Math.max(0, view.top - origin.current);
  const start = items.length ? Math.max(0, itemAt(offsets, Math.max(0, top - height))) : 0;
  const end = items.length ? Math.min(items.length, itemAt(offsets, top + height * 2) + 1) : 0;
  return { start, end, top: offsets[start]!, bottom: offsets.at(-1)! - offsets[end]!, startRef, measureRef, scrollToIndex, refresh };
}
