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
  task: "birefnet-mask",
  version: VERSION,
  execute: async ({ repoRoot, resultDir, logPath, onProgress }) => {
    const input = path.join(repoRoot, "tests", "fixtures", "green-disk.png");
    const sdk = new GptImg();
    const result = await sdk.mask(
      {
        in: input,
        method: "ai",
        outDir: resultDir,
        outName: "mask",
        log: logPath,
        overwrite: true,
      },
      { onProgress },
    );
    if (result.output === null) throw new Error("BiRefNet returned no output image.");

    const bytes = await readFile(result.output);
    const file = await stat(result.output);
    const metadata = await sharp(bytes).metadata();
    if (file.size === 0 || metadata.width !== 128 || metadata.height !== 128) {
      throw new Error(
        `BiRefNet output is invalid: ${file.size} bytes, ${metadata.width ?? "?"}x${metadata.height ?? "?"}.`,
      );
    }
    if (result.stats.method !== "ai" || result.stats.model !== "birefnet") {
      throw new Error("BiRefNet returned unexpected mask statistics.");
    }
    if (
      result.stats.width !== 128 ||
      result.stats.height !== 128 ||
      !Number.isInteger(result.stats.removedPixels) ||
      result.stats.removedPixels < 0 ||
      result.stats.removedPixels > 128 * 128 ||
      !Number.isFinite(result.stats.removedFraction) ||
      result.stats.removedFraction < 0 ||
      result.stats.removedFraction > 1
    ) {
      throw new Error("BiRefNet returned invalid mask dimensions or pixel statistics.");
    }

    return {
      input,
      inputSha256: sha256(await readFile(input)),
      output: result.output,
      outputBytes: file.size,
      outputSha256: sha256(bytes),
      width: metadata.width,
      height: metadata.height,
      stats: result.stats,
      sdkLog: result.logPath,
    };
  },
});
