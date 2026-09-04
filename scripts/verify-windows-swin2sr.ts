import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { GptImg, VERSION } from "../src/index.js";
import { runWindowsHeavyValidation } from "./windows-heavy-validation.js";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

await runWindowsHeavyValidation({
  task: "swin2sr-upscale",
  version: VERSION,
  execute: async ({ repoRoot, resultDir, logPath, onProgress }) => {
    const input = path.join(repoRoot, "tests", "fixtures", "green-disk.png");
    const sdk = new GptImg();
    const result = await sdk.upscale(
      {
        in: input,
        toSize: 256,
        outDir: resultDir,
        outName: "upscaled",
        log: logPath,
        overwrite: true,
      },
      { onProgress },
    );

    const bytes = await readFile(result.output);
    const file = await stat(result.output);
    const metadata = await sharp(bytes).metadata();
    if (file.size === 0 || metadata.width !== 256 || metadata.height !== 256) {
      throw new Error(
        `Swin2SR output is invalid: ${file.size} bytes, ${metadata.width ?? "?"}x${metadata.height ?? "?"}.`,
      );
    }
    if (
      result.sourceWidth !== 128 ||
      result.sourceHeight !== 128 ||
      result.modelWidth !== 512 ||
      result.modelHeight !== 512 ||
      result.tiles !== 1
    ) {
      throw new Error(
        `Swin2SR returned unexpected geometry: source ${result.sourceWidth}x${result.sourceHeight}, model ${result.modelWidth}x${result.modelHeight}, ${result.tiles} tiles.`,
      );
    }

    return {
      input,
      inputSha256: sha256(await readFile(input)),
      output: result.output,
      outputBytes: file.size,
      outputSha256: sha256(bytes),
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      modelWidth: result.modelWidth,
      modelHeight: result.modelHeight,
      width: result.width,
      height: result.height,
      tile: result.tile,
      tiles: result.tiles,
      sdkLog: result.logPath,
    };
  },
});
