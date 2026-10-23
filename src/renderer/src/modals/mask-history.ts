export interface MaskPoint { x: number; y: number }
export interface MaskStroke { kind: "stroke"; width: number; points: MaskPoint[] }
export type MaskCommand = MaskStroke | { kind: "clear" };

// Older commands are folded into one canvas; only the recent commands are
// retained as geometry, so undo never holds a full image per action.
export class MaskHistory {
  private recent: MaskCommand[] = [];
  private basePainted = false;

  private checkpoint: (command: MaskCommand) => void;

  constructor(checkpoint: (command: MaskCommand) => void) { this.checkpoint = checkpoint; }

  get commands(): readonly MaskCommand[] { return this.recent; }
  get painted(): boolean { return this.recent.at(-1)?.kind === "stroke" || (this.recent.length === 0 && this.basePainted); }

  append(command: MaskCommand): void {
    this.recent.push(command);
    if (this.recent.length > 20) {
      const oldest = this.recent.shift()!;
      this.checkpoint(oldest);
      this.basePainted = oldest.kind === "stroke";
    }
  }

  undo(): void { this.recent.pop(); }
}

export function drawMaskSegment(ctx: CanvasRenderingContext2D, width: number, from: MaskPoint, to: MaskPoint): void {
  ctx.strokeStyle = "rgba(232, 96, 60, 1)";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
}

export function replayMaskCommand(ctx: CanvasRenderingContext2D, command: MaskCommand): void {
  if (command.kind === "clear") {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    return;
  }
  let previous = command.points[0]!;
  for (const point of command.points) {
    drawMaskSegment(ctx, command.width, previous, point);
    previous = point;
  }
}
