import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GptImg } from "../../src/gptimg.js";

describe("GptImg SDK surface", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-sdk-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("uses custom profile and log directories", () => {
    const sdk = new GptImg({
      profileDir: path.join(tmp, "profile-dir"),
      logDir: path.join(tmp, "log-dir"),
    });

    expect(sdk.profileDir).toBe(path.join(tmp, "profile-dir"));
    expect(sdk.logDir).toBe(path.join(tmp, "log-dir"));
  });

  it("exposes the documented helper groups as callable functions", async () => {
    const sdk = new GptImg({ profileDir: tmp, logDir: tmp });
    const profilePath = path.join(tmp, "profile.json");
    const recipePath = path.join(tmp, "recipe.json");

    await sdk.profile.setApiKey("sk-sdk", { path: profilePath });
    const profile = await sdk.profile.load(profilePath);
    expect(sdk.profile.resolve(profile).apiKey).toBe("sk-sdk");
    await sdk.profile.clearApiKey({ path: profilePath });

    await writeFile(recipePath, '{"generate":{"n":1}}\n');
    expect(await sdk.recipe.load(recipePath)).toEqual({ generate: { n: 1 } });
    expect(sdk.recipe.merge({}, { vision: { shrink: { width: 1, height: 1 } } })).toEqual({
      vision: { shrink: { width: 1, height: 1 } },
    });

    expect(typeof sdk.sidecar.read).toBe("function");
    expect(typeof sdk.sidecar.write).toBe("function");
    expect(typeof sdk.image.hash).toBe("function");
    expect(typeof sdk.image.detectFormat).toBe("function");
    expect(typeof sdk.image.shrinkForVision).toBe("function");
    expect(typeof sdk.log.open).toBe("function");
    expect(typeof sdk.log.append).toBe("function");
    expect(typeof sdk.log.close).toBe("function");
    expect(typeof sdk.log.createLogger).toBe("function");
    expect(typeof sdk.keycheck).toBe("function");
    expect(typeof sdk.framecheck).toBe("function");
    expect(typeof sdk.grid).toBe("function");
  });

  it("keycheck resolves the key from the sidecar and measures residue end-to-end", async () => {
    const sdk = new GptImg({ profileDir: tmp, logDir: tmp });
    // A blue island over transparent, with a generate-style sidecar recording a
    // green chroma key beside it — the from-sidecar path mask uses.
    const W = 8, H = 8;
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 2; y <= 5; y++)
      for (let x = 2; x <= 5; x++) {
        const i = (y * W + x) * 4;
        rgba[i] = 40; rgba[i + 1] = 80; rgba[i + 2] = 200; rgba[i + 3] = 255;
      }
    const imgPath = path.join(tmp, "cutout.png");
    await sharp(Buffer.from(rgba), { raw: { width: W, height: H, channels: 4 } }).png().toFile(imgPath);
    await writeFile(
      path.join(tmp, "cutout.json"),
      JSON.stringify({ request: { chroma: { color: "#00ff00" } }, response: {}, files: [] }),
    );

    const res = await sdk.keycheck({ in: imgPath, key: "from-sidecar" });
    expect(res.key).toBe("#00ff00");
    expect(res.keySource).toBe("sidecar");
    expect(res.residuePixels).toBe(0);
    expect(res.verdict).toBe("clean");
  });

  it("keycheck accepts an explicit key and writes a heatmap", async () => {
    const sdk = new GptImg({ profileDir: tmp, logDir: tmp });
    const W = 8, H = 8;
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 2; y <= 5; y++)
      for (let x = 2; x <= 5; x++) {
        const i = (y * W + x) * 4;
        rgba[i] = 40; rgba[i + 1] = 80; rgba[i + 2] = 200; rgba[i + 3] = 255;
      }
    const imgPath = path.join(tmp, "cut.png");
    await sharp(Buffer.from(rgba), { raw: { width: W, height: H, channels: 4 } }).png().toFile(imgPath);

    const res = await sdk.keycheck({ in: imgPath, key: "#00ff00", heatmap: true, outName: "qa" });
    expect(res.keySource).toBe("explicit");
    expect(res.key).toBe("#00ff00");
    expect(res.heatmapPath).toBe(path.join(tmp, "qa.png"));
    const meta = await sharp(res.heatmapPath!).metadata();
    expect(meta.width).toBe(W);
    expect(meta.height).toBe(H);
  });

  it("framecheck measures subject placement and verdicts off-centre end-to-end", async () => {
    const sdk = new GptImg({ profileDir: tmp, logDir: tmp });
    // A 4×4 solid square pushed to the left (L=1, R=5) in a 10×10 canvas.
    const W = 10, H = 10;
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 3; y <= 6; y++)
      for (let x = 1; x <= 4; x++) {
        const i = (y * W + x) * 4;
        rgba[i] = 200; rgba[i + 1] = 50; rgba[i + 2] = 50; rgba[i + 3] = 255;
      }
    const imgPath = path.join(tmp, "subject.png");
    await sharp(Buffer.from(rgba), { raw: { width: W, height: H, channels: 4 } }).png().toFile(imgPath);

    const res = await sdk.framecheck({ in: imgPath });
    expect(res.solidBBox).toEqual({ x: 1, y: 3, width: 4, height: 4 });
    expect(res.margins).toEqual({ left: 1, right: 5, top: 3, bottom: 3 });
    expect(res.deltas!.horizontal).toBe(4);
    expect(res.verdict).toBe("offset");
    expect(typeof res.logPath).toBe("string");
  });

  it("grid tiles inputs into a sheet beside the first input", async () => {
    const sdk = new GptImg({ profileDir: tmp, logDir: tmp });
    const paths: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = path.join(tmp, `tile-${i}.png`);
      await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: i * 80, g: 0, b: 0, alpha: 1 } } })
        .png()
        .toFile(p);
      paths.push(p);
    }
    const res = await sdk.grid({ inputs: paths, cell: 32, gap: 4, outName: "sheet" });
    expect(res.placed).toBe(3);
    expect(res.skipped).toEqual([]);
    expect(res.output).toBe(path.join(tmp, "sheet.png"));
  });
});
