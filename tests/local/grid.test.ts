import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGrid } from "../../src/local/grid.js";

async function makeSolid(
  filePath: string,
  w: number,
  h: number,
  rgba: [number, number, number, number],
): Promise<string> {
  await sharp({
    create: {
      width: w,
      height: h,
      channels: 4,
      background: { r: rgba[0], g: rgba[1], b: rgba[2], alpha: rgba[3] / 255 },
    },
  })
    .png()
    .toFile(filePath);
  return filePath;
}

async function readRGBA(filePath: string): Promise<{
  data: Uint8Array;
  width: number;
  height: number;
}> {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}
function pxAt(
  img: { data: Uint8Array; width: number },
  x: number,
  y: number,
): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!];
}
function cellCenter(i: number, cols: number, cell: number, gap: number): [number, number] {
  const col = i % cols;
  const row = Math.floor(i / cols);
  return [gap + col * (cell + gap) + Math.floor(cell / 2), gap + row * (cell + gap) + Math.floor(cell / 2)];
}

const CELL = 64;
const GAP = 8;
const COLORS: [number, number, number, number][] = [
  [255, 0, 0, 255],
  [0, 255, 0, 255],
  [0, 0, 255, 255],
  [255, 255, 0, 255],
  [0, 255, 255, 255],
];

describe("runGrid", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-grid-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("tiles N images into ceil(sqrt(n)) columns with the right geometry and places each tile", async () => {
    const inputs: string[] = [];
    for (let i = 0; i < 5; i++) inputs.push(await makeSolid(path.join(tmp, `c${i}.png`), CELL, CELL, COLORS[i]!));
    const out = path.join(tmp, "sheet.png");

    const res = await runGrid({ inputs, out, cell: CELL, gap: GAP });
    expect(res.placed).toBe(5);
    expect(res.skipped).toEqual([]);
    expect(res.cols).toBe(3); // ceil(sqrt(5))
    expect(res.rows).toBe(2);
    expect(res.width).toBe(3 * CELL + 4 * GAP);
    expect(res.height).toBe(2 * CELL + 3 * GAP);

    const sheet = await readRGBA(out);
    expect(sheet.width).toBe(res.width);
    expect(sheet.height).toBe(res.height);
    // Each solid tile fills its cell, so the cell centre carries that tile's colour.
    for (let i = 0; i < 5; i++) {
      const [cx, cy] = cellCenter(i, res.cols, CELL, GAP);
      expect(pxAt(sheet, cx, cy), `tile ${i}`).toEqual(COLORS[i]!);
    }
  });

  it("contain-fits a non-square image: centred in its cell, transparent padding around it", async () => {
    const wide = await makeSolid(path.join(tmp, "wide.png"), 100, 20, [200, 0, 0, 255]);
    const out = path.join(tmp, "sheet.png");
    const res = await runGrid({ inputs: [wide], out, cell: CELL, gap: GAP });
    expect(res.cols).toBe(1);
    expect(res.rows).toBe(1);

    const sheet = await readRGBA(out);
    const [cx, cy] = cellCenter(0, 1, CELL, GAP);
    expect(pxAt(sheet, cx, cy)).toEqual([200, 0, 0, 255]); // band centre is the image
    // Top of the cell is padding (the 100x20 image shrinks to a thin centred band).
    expect(pxAt(sheet, cx, GAP + 1)[3]).toBe(0);
  });

  it("skips an unreadable input but still writes the sheet, reporting the skip", async () => {
    const a = await makeSolid(path.join(tmp, "a.png"), CELL, CELL, COLORS[0]!);
    const b = await makeSolid(path.join(tmp, "b.png"), CELL, CELL, COLORS[1]!);
    const missing = path.join(tmp, "nope.png");
    const out = path.join(tmp, "sheet.png");

    const res = await runGrid({ inputs: [a, missing, b], out, cell: CELL, gap: GAP });
    expect(res.count).toBe(3);
    expect(res.placed).toBe(2);
    expect(res.skipped).toEqual([missing]);
    expect(res.cols).toBe(2); // ceil(sqrt(2)), over the 2 readable tiles
    const sheet = await readRGBA(out);
    expect(sheet.width).toBe(res.width); // output still written
  });

  it("throws when no input is readable (an empty sheet is a caller error)", async () => {
    const out = path.join(tmp, "sheet.png");
    await expect(
      runGrid({ inputs: [path.join(tmp, "x.png"), path.join(tmp, "y.png")], out }),
    ).rejects.toThrow(/none of the 2 input/);
  });

  it("fills the gaps with the background colour (and leaves them transparent by default)", async () => {
    const tile = await makeSolid(path.join(tmp, "t.png"), CELL, CELL, [0, 0, 255, 255]);

    const red = path.join(tmp, "red.png");
    await runGrid({ inputs: [tile], out: red, cell: CELL, gap: GAP, background: "#ff0000" });
    const redSheet = await readRGBA(red);
    expect(pxAt(redSheet, 0, 0)).toEqual([255, 0, 0, 255]); // outer gap border is the bg

    const clear = path.join(tmp, "clear.png");
    await runGrid({ inputs: [tile], out: clear, cell: CELL, gap: GAP });
    const clearSheet = await readRGBA(clear);
    expect(pxAt(clearSheet, 0, 0)[3]).toBe(0); // transparent by default
  });

  it("honours an explicit column count", async () => {
    const inputs: string[] = [];
    for (let i = 0; i < 3; i++) inputs.push(await makeSolid(path.join(tmp, `c${i}.png`), CELL, CELL, COLORS[i]!));
    const out = path.join(tmp, "sheet.png");
    const res = await runGrid({ inputs, out, cols: 1, cell: CELL, gap: GAP });
    expect(res.cols).toBe(1);
    expect(res.rows).toBe(3);
    expect(res.width).toBe(CELL + 2 * GAP);
    expect(res.height).toBe(3 * CELL + 4 * GAP);
  });
});
