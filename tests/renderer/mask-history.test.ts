import { describe, expect, it, vi } from "vitest";
import { MaskHistory, drawMaskSegment, replayMaskCommand, type MaskCommand, type MaskStroke } from "../../src/renderer/src/modals/mask-history.ts";

const stroke = (x: number, width = 12): MaskStroke => ({ kind: "stroke", width, points: [{ x, y: 2 }, { x: x + 1, y: 3 }] });

describe("Mask undo history", () => {
  it("undoes clear and strokes using command state", () => {
    const checkpoint = vi.fn();
    const history = new MaskHistory(checkpoint);
    expect(history.painted).toBe(false);
    history.append(stroke(1));
    history.append({ kind: "clear" });
    expect(history.painted).toBe(false);
    history.undo();
    expect(history.painted).toBe(true);
    history.undo();
    expect(history.painted).toBe(false);
    expect(history.commands).toEqual([]);
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it("retains twenty commands and folds older strokes into the preserved base", () => {
    const base: MaskCommand[] = [];
    const history = new MaskHistory((command) => base.push(command));
    for (let x = 0; x < 25; x++) {
      history.append(stroke(x));
      expect(history.commands.length).toBeLessThanOrEqual(20);
    }
    expect(base).toEqual(Array.from({ length: 5 }, (_, x) => stroke(x)));
    expect(history.commands).toEqual(Array.from({ length: 20 }, (_, x) => stroke(x + 5)));
    for (let i = 0; i < 20; i++) history.undo();
    expect(history.commands).toEqual([]);
    expect(history.painted).toBe(true);
    expect(base).toEqual(Array.from({ length: 5 }, (_, x) => stroke(x)));
  });

  it("checkpoints clear and keeps its empty base after all retained strokes are undone", () => {
    const base: MaskCommand[] = [];
    const history = new MaskHistory((command) => base.push(command));
    history.append(stroke(0));
    history.append({ kind: "clear" });
    for (let x = 1; x <= 20; x++) history.append(stroke(x));
    expect(base).toEqual([stroke(0), { kind: "clear" }]);
    for (let i = 0; i < 20; i++) history.undo();
    expect(history.painted).toBe(false);
  });

  it("replays exactly the incremental segments with each stroke's original source width", () => {
    const calls: unknown[] = [];
    const ctx = {
      canvas: { width: 4000, height: 3000 },
      lineWidth: 0,
      beginPath: vi.fn(),
      moveTo: (x: number, y: number) => calls.push(["from", x, y]),
      lineTo: (x: number, y: number) => calls.push(["to", x, y]),
      stroke(this: { lineWidth: number }) { calls.push(["stroke", this.lineWidth]); },
      clearRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    const command = stroke(3, 120);
    drawMaskSegment(ctx, command.width, command.points[0]!, command.points[0]!);
    drawMaskSegment(ctx, command.width, command.points[0]!, command.points[1]!);
    const incremental = [...calls];
    calls.length = 0;
    replayMaskCommand(ctx, command);
    expect(calls).toEqual(incremental);
    replayMaskCommand(ctx, stroke(9, 24));
    expect(calls.filter((call) => (call as unknown[])[0] === "stroke")).toEqual([["stroke", 120], ["stroke", 120], ["stroke", 24], ["stroke", 24]]);
    replayMaskCommand(ctx, { kind: "clear" });
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 4000, 3000);
  });
});
