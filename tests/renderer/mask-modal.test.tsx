// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MaskModal } from "../../src/renderer/src/modals/MaskModal.tsx";
import { fakeApi, renderInApp } from "./harness.tsx";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("draws incrementally, checkpoints old strokes, and keeps twenty undoable actions without pixel snapshots", async () => {
  fakeApi();
  vi.stubGlobal("Image", class {
    naturalWidth = 4000;
    naturalHeight = 3000;
    onload: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("PointerEvent", MouseEvent);
  const contexts = new Map<HTMLCanvasElement, CanvasRenderingContext2D>();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    if (!contexts.has(this)) contexts.set(this, {
      canvas: this,
      beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
      clearRect: vi.fn(), drawImage: vi.fn(),
      getImageData: () => { throw new Error("Pixel snapshots must not be used for undo"); },
    } as unknown as CanvasRenderingContext2D);
    return contexts.get(this)!;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 75 } as DOMRect);
  const rendered = await renderInApp(() => <MaskModal absolute="/image.png" onClose={vi.fn()} onDone={vi.fn()} />);
  const live = await screen.findByRole("img", { name: "The image, with the painted area" }) as HTMLCanvasElement;
  live.setPointerCapture = vi.fn();
  const paintStroke = (x: number) => {
    fireEvent.pointerDown(live, { clientX: x, clientY: 2 });
    fireEvent.pointerMove(live, { clientX: x + 1, clientY: 3 });
    fireEvent.pointerUp(live);
  };
  for (let i = 0; i < 21; i++) paintStroke(i);
  expect(contexts.size).toBe(2);
  const base = [...contexts.keys()].find((canvas) => canvas !== live)!;
  expect(contexts.get(base)!.stroke).toHaveBeenCalledTimes(2);
  expect(contexts.get(base)!.lineWidth).toBe(1600);
  const undo = screen.getByRole("button", { name: "Undo" });
  for (let i = 0; i < 20; i++) fireEvent.click(undo);
  expect(screen.getByRole("button", { name: "Undo" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Use this area" })).toHaveProperty("disabled", false);
  expect(contexts.get(live)!.drawImage).toHaveBeenLastCalledWith(base, 0, 0);
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(screen.getByRole("button", { name: "Use this area" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(screen.getByRole("button", { name: "Use this area" })).toHaveProperty("disabled", false);
  rendered.unmount();
  expect(base.width).toBe(0);
  expect(live.width).toBe(0);
});
