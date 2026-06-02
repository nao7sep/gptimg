import { InvalidArgumentError, type Command } from "commander";
import { GptImg } from "../../gptimg.js";
import type { LayerGravity, LayerOffset } from "../../types.js";
import { getAbortSignal } from "../abort.js";
import { emit } from "../output.js";

const GRAVITIES: LayerGravity[] = [
  "center",
  "north",
  "south",
  "east",
  "west",
  "northeast",
  "northwest",
  "southeast",
  "southwest",
];

function parseScaleOpt(v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new InvalidArgumentError(`--scale: must be a positive number`);
  }
  return n;
}

function parseGravityOpt(v: string): LayerGravity {
  if ((GRAVITIES as string[]).includes(v)) return v as LayerGravity;
  throw new InvalidArgumentError(
    `--gravity: must be one of ${GRAVITIES.join("|")}`,
  );
}

function parseTopOffsetOpt(v: string): LayerOffset {
  // Format: "x,y" — two integers (may be negative).
  const m = /^(-?\d+),(-?\d+)$/.exec(v.trim());
  if (!m) {
    throw new InvalidArgumentError(`--top-offset: must be "x,y" integers`);
  }
  return { x: Number(m[1]!), y: Number(m[2]!) };
}

interface LayerCliOpts {
  base: string;
  top: string;
  scale?: number;
  gravity?: LayerGravity;
  topOffset?: LayerOffset;
  outDir?: string;
  outName?: string;
  log?: string;
  overwrite?: boolean;
}

export function registerLayer(program: Command): void {
  const cmd = program
    .command("layer")
    .description(
      "Alpha-composite a top RGBA image onto a base RGBA image (sharp source-over).",
    )
    .requiredOption("--base <path>", "Base RGBA image path")
    .requiredOption("--top <path>", "Top RGBA image path")
    .option(
      "--scale <n>",
      "Resize top so its longer side = scale * min(baseW, baseH). Preserves aspect.",
      parseScaleOpt,
    )
    .option(
      "--gravity <pos>",
      `Placement anchor: ${GRAVITIES.join("|")}. Default center. Ignored if --top-offset is given.`,
      parseGravityOpt,
    )
    .option(
      "--top-offset <x,y>",
      "Explicit pixel offset of top's top-left corner from base's top-left (overrides --gravity).",
      parseTopOffsetOpt,
    )
    .option("--out-dir <dir>", "Output directory (default: same as --base)")
    .option(
      "--out-name <name>",
      "Output filename (default: <base-stem>-layered.png)",
    )
    .option("--log <path>", "Path to log JSONL file")
    .option("--overwrite", "Overwrite an existing output file");

  cmd.action(async (opts: LayerCliOpts) => {
    const sdk = new GptImg();
    const result = await sdk.layer(
      {
        base: opts.base,
        top: opts.top,
        scale: opts.scale,
        gravity: opts.gravity,
        topOffset: opts.topOffset,
        outDir: opts.outDir,
        outName: opts.outName,
        log: opts.log,
        overwrite: opts.overwrite,
      },
      { signal: getAbortSignal() },
    );
    emit(result);
  });
}
