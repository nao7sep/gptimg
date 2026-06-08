import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planIconOutputs, runIcon } from "../../src/local/icon.js";

/** A solid square RGBA PNG of the given size. */
async function writeSquare(
  filePath: string,
  size: number,
  rgb: [number, number, number] = [60, 90, 200],
): Promise<void> {
  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha: 1 },
    },
  })
    .png()
    .toFile(filePath);
}

/** Parse an .icns and return its entry OSType codes (excluding the "TOC " block). */
function icnsEntryTypes(buf: Buffer): string[] {
  const types: string[] = [];
  let off = 8; // skip "icns" magic + total-length header
  while (off + 8 <= buf.length) {
    const type = buf.toString("ascii", off, off + 4);
    const len = buf.readUInt32BE(off + 4);
    if (len < 8) break;
    if (type !== "TOC ") types.push(type);
    off += len;
  }
  return types;
}

describe("planIconOutputs", () => {
  it("plans the three core files by default", () => {
    const plan = planIconOutputs("/out", "icon", false);
    expect(plan.icns).toBe(path.join("/out", "icon.icns"));
    expect(plan.ico).toBe(path.join("/out", "icon.ico"));
    expect(plan.png).toBe(path.join("/out", "icon.png"));
    expect(plan.pngSet).toEqual([]);
    expect(plan.all).toEqual([plan.icns, plan.ico, plan.png]);
  });

  // The name-stem validation (no path separators) now lives in verbs/schemas.ts
  // (validateIconArgs) and is covered by tests/verbs/schemas.test.ts.
  it("adds the sized-PNG set when requested and honors the name stem", () => {
    const plan = planIconOutputs("/out", "app", true);
    expect(plan.png).toBe(path.join("/out", "app.png"));
    expect(plan.pngSet.map((p) => path.basename(p.path))).toEqual([
      "app-16.png",
      "app-32.png",
      "app-48.png",
      "app-64.png",
      "app-128.png",
      "app-256.png",
      "app-512.png",
      "app-1024.png",
    ]);
    expect(plan.all).toHaveLength(3 + 8);
  });
});

describe("runIcon", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-icon-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("writes a valid icns, ico, and 1024 png from a 1024 master", async () => {
    const master = path.join(tmp, "master.png");
    await writeSquare(master, 1024);

    const res = await runIcon({ in: master, outDir: tmp });
    expect(res.outputs).toEqual([res.icns, res.ico, res.png]);
    expect(res.sourceWidth).toBe(1024);

    // ICNS magic: "icns" + big-endian total length matching the file.
    const icns = await readFile(res.icns);
    expect(icns.toString("ascii", 0, 4)).toBe("icns");
    expect(icns.readUInt32BE(4)).toBe(icns.length);

    // ICO directory header: reserved=0, type=1 (icon), count>0 (little-endian).
    const ico = await readFile(res.ico);
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(7); // 16,24,32,48,64,128,256

    const pngMeta = await sharp(res.png).metadata();
    expect(pngMeta.width).toBe(1024);
    expect(pngMeta.height).toBe(1024);
    expect(pngMeta.format).toBe("png");
  });

  it("packs every ICNS entry, including the largest retina sizes", async () => {
    const master = path.join(tmp, "master.png");
    await writeSquare(master, 1024);

    const res = await runIcon({ in: master, outDir: tmp });
    const types = icnsEntryTypes(await readFile(res.icns));
    // All seven rows of ICNS_ENTRIES, ten codes total. ic14 (512@2x) and ic10
    // (1024) are written last and were dropped before addFromPng was awaited.
    expect(types.sort()).toEqual(
      ["ic04", "ic05", "ic07", "ic08", "ic09", "ic10", "ic11", "ic12", "ic13", "ic14"].sort(),
    );
  });

  it("emits the sized-PNG set with correct dimensions when pngs=true", async () => {
    const master = path.join(tmp, "master.png");
    await writeSquare(master, 1024);

    const res = await runIcon({ in: master, outDir: tmp, name: "app", pngs: true });
    expect(res.pngSet).toHaveLength(8);
    for (const { size, path: p } of res.pngSet) {
      expect(existsSync(p)).toBe(true);
      const m = await sharp(p).metadata();
      expect(m.width).toBe(size);
      expect(m.height).toBe(size);
    }
    expect(res.outputs).toContain(path.join(tmp, "app.icns"));
  });

  it("downsamples a larger-than-1024 master to a 1024 png", async () => {
    const master = path.join(tmp, "big.png");
    await writeSquare(master, 2048);
    const res = await runIcon({ in: master, outDir: tmp });
    expect(res.sourceWidth).toBe(2048);
    const m = await sharp(res.png).metadata();
    expect(m.width).toBe(1024);
  });

  it("rejects a non-square master", async () => {
    const master = path.join(tmp, "wide.png");
    await sharp({
      create: { width: 1024, height: 512, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
    })
      .png()
      .toFile(master);
    await expect(runIcon({ in: master, outDir: tmp })).rejects.toMatchObject({
      errorType: "localOp",
      code: "args.invalid",
    });
  });

  it("rejects a master smaller than 1024", async () => {
    const master = path.join(tmp, "small.png");
    await writeSquare(master, 512);
    await expect(runIcon({ in: master, outDir: tmp })).rejects.toMatchObject({
      code: "args.invalid",
    });
  });
});
