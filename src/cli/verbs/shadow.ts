import { InvalidArgumentError, type Command } from "commander";
import { GptImg } from "../../gptimg.js";
import type { ShadowOffset } from "../../types.js";
import { getAbortSignal } from "../abort.js";
import { emit } from "../output.js";
import { hexOption } from "../parsers.js";

function parseNonNegativeNumberOpt(name: string) {
  return (v: string): number => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      throw new InvalidArgumentError(`${name}: must be a number >= 0`);
    }
    return n;
  };
}

function parseOpacityOpt(v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    throw new InvalidArgumentError("--opacity: must be in (0, 1]");
  }
  return n;
}

function parseSpreadOpt(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    throw new InvalidArgumentError("--spread: must be a non-negative integer");
  }
  return n;
}

function parseOffsetOpt(v: string): ShadowOffset {
  const m = /^(-?\d+),(-?\d+)$/.exec(v.trim());
  if (!m) {
    throw new InvalidArgumentError('--offset: must be "x,y" integers');
  }
  return { x: Number(m[1]!), y: Number(m[2]!) };
}

interface ShadowCliOpts {
  in: string;
  blur?: number;
  offset?: ShadowOffset;
  color?: string;
  opacity?: number;
  spread?: number;
  keepCanvas?: boolean;
  outDir?: string;
  outName?: string;
  log?: string;
  overwrite?: boolean;
}

export function registerShadow(program: Command): void {
  const cmd = program
    .command("shadow")
    .description(
      "Cast a soft drop shadow from an RGBA image's alpha shape and composite the subject on top.",
    )
    .requiredOption("--in <path>", "RGBA image with transparency")
    .option(
      "--blur <px>",
      "Gaussian blur sigma for the shadow edge. Default 12.",
      parseNonNegativeNumberOpt("--blur"),
    )
    .option(
      "--offset <x,y>",
      'Shadow displacement, integers (may be negative). Default "0,8".',
      parseOffsetOpt,
    )
    .option("--color <#rrggbb>", "Shadow color. Default #000000.", hexOption("--color"))
    .option(
      "--opacity <0..1>",
      "Peak shadow opacity. Default 0.35.",
      parseOpacityOpt,
    )
    .option(
      "--spread <px>",
      "Grow the shadow shape outward before blurring. Default 0.",
      parseSpreadOpt,
    )
    .option(
      "--keep-canvas",
      "Keep the input dimensions, clipping any shadow outside (default: grow to fit).",
    )
    .option("--out-dir <dir>", "Output directory (default: same as --in)")
    .option(
      "--out-name <name>",
      "Output filename (default: <in-stem>-shadow.png)",
    )
    .option("--log <path>", "Path to log JSONL file")
    .option("--overwrite", "Overwrite an existing output file");

  cmd.action(async (opts: ShadowCliOpts) => {
    const sdk = new GptImg();
    const result = await sdk.shadow(
      {
        in: opts.in,
        blur: opts.blur,
        offset: opts.offset,
        color: opts.color,
        opacity: opts.opacity,
        spread: opts.spread,
        keepCanvas: opts.keepCanvas,
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
