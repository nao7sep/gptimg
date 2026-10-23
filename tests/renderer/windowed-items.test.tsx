// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useMemo, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWindowedItems } from "../../src/renderer/src/components/use-windowed-items.ts";

const heights = new Map<string, number>();
const observers: { callback: ResizeObserverCallback; nodes: Set<Element> }[] = [];

beforeEach(() => {
  heights.clear(); observers.length = 0;
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const viewport = this.closest("[data-viewport]") as HTMLElement | null;
    return { top: this.dataset.start === "true" ? -(viewport?.scrollTop ?? 0) : 0, height: heights.get(this.dataset.windowedId ?? "") ?? 100 } as DOMRect;
  });
  vi.stubGlobal("ResizeObserver", class {
    state: { callback: ResizeObserverCallback; nodes: Set<Element> };
    constructor(callback: ResizeObserverCallback) { this.state = { callback, nodes: new Set() }; observers.push(this.state); }
    observe(node: Element) { this.state.nodes.add(node); }
    unobserve(node: Element) { this.state.nodes.delete(node); }
    disconnect() { this.state.nodes.clear(); }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function Host({ resetKey = "one", uniform = false }: { resetKey?: string; uniform?: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  const items = useMemo(() => Array.from({ length: 1000 }, (_, i) => ({ id: String(i), estimatedHeight: 100 })), []);
  const windowed = useWindowedItems(items, scroller, resetKey, uniform);
  return <><button onClick={() => windowed.scrollToIndex(900)}>Jump</button><div ref={scroller} data-testid="viewport" data-viewport="true">
    <div ref={windowed.startRef} data-start="true" style={{ height: windowed.top }} />
    {items.slice(windowed.start, windowed.end).map((item) => <div key={item.id} ref={windowed.measureRef(item.id)} data-testid={`row-${item.id}`}>{item.id}</div>)}
    <div style={{ height: windowed.bottom }} />
  </div></>;
}

function measureRows() {
  act(() => {
    for (const observer of observers) {
      const entries = [...observer.nodes].filter((node) => (node as HTMLElement).dataset.windowedId).map((target) => ({ target } as ResizeObserverEntry));
      if (entries.length) observer.callback(entries, {} as ResizeObserver);
    }
  });
}

describe("windowed item geometry", () => {
  it("uses the first measured row height for a uniform list", () => {
    render(<Host uniform />);
    heights.set("0", 56);
    measureRows();
    fireEvent.click(screen.getByRole("button", { name: "Jump" }));
    expect(screen.getByTestId("viewport").scrollTop).toBe(50156);
    expect(screen.getByTestId("row-900")).toBeTruthy();
  });
  it("mounts a bounded slice and scrolls to an index before it is mounted", () => {
    render(<Host />);
    expect(screen.queryByTestId("row-900")).toBeNull();
    expect(document.querySelectorAll("[data-windowed-id]").length).toBeLessThanOrEqual(10);
    fireEvent.click(screen.getByRole("button", { name: "Jump" }));
    expect(screen.getByTestId("viewport").scrollTop).toBe(89800);
    expect(screen.getByTestId("row-900")).toBeTruthy();
    expect(document.querySelectorAll("[data-windowed-id]").length).toBeLessThanOrEqual(10);
  });

  it("preserves the visible anchor when an overscan row above grows and resets measurements by session", () => {
    const rendered = render(<Host />);
    const viewport = screen.getByTestId("viewport");
    viewport.scrollTop = 500;
    fireEvent.scroll(viewport);
    heights.set("3", 150);
    measureRows();
    expect(viewport.scrollTop).toBe(550);
    rendered.rerender(<Host resetKey="two" />);
    fireEvent.click(screen.getByRole("button", { name: "Jump" }));
    expect(viewport.scrollTop).toBe(89800);
  });
});
