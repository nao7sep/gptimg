import { InvalidArgumentError, type Command } from "commander";
import { GptImg } from "../../gptimg.js";
import type { BackplateShape } from "../../types.js";
import { getAbortSignal } from "../abort.js";
import { emit } from "../output.js";
import { hexOption } from "../parsers.js";

function parsePositiveIntOpt(name: string) {
  return (v: string): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) {
      throw new InvalidArgumentError(`${name}: must be a positive integer`);
    }
    return n;
  };
}

function parseRangeOpt(name: string, min: number, max: number) {
  return (v: string): number => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) {
      throw new InvalidArgumentError(`${name}: must be in [${min}, ${max}]`);
    }
    return n;
  };
}

function parseFiniteOpt(name: string) {
  return (v: string): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) {
      throw new InvalidArgumentError(`${name}: must be a finite number`);
    }
    return n;
  };
}

function parseShapeOpt(v: string): BackplateShape {
  if (v === "rect" || v === "squircle") return v;
  throw new InvalidArgumentError(`--shape: must be one of rect|squircle`);
}

interface BackplateCliOpts {
  size?: number;
  content?: number;
  radius?: number;
  from: string;
  to: string;
  angle?: number;
  shape?: BackplateShape;
  outDir?: string;
  outName?: string;
  log?: string;
  overwrite?: boolean;
}

export function registerBackplate(program: Command): void {
  const cmd = program
    .command("backplate")
    .description(
      "Synthesize a centered rounded/squircle plate filled with a linear gradient on a transparent square canvas.",
    )
    .requiredOption("--from <#rrggbb>", "Gradient start color", hexOption("--from"))
    .requiredOption("--to <#rrggbb>", "Gradient end color", hexOption("--to"))
    .option(
      "--size <px>",
      "Output canvas side in pixels. Default 1024.",
      parsePositiveIntOpt("--size"),
    )
    .option(
      "--content <pct>",
      "Content side as a fraction of --size (0..1]. Default 0.80.",
      parseRangeOpt("--content", 0, 1),
    )
    .option(
      "--radius <pct>",
      "Corner radius as a fraction of the content side [0..0.5]. Default 0.225.",
      parseRangeOpt("--radius", 0, 0.5),
    )
    .option(
      "--angle <deg>",
      "Gradient angle (deg, CSS convention: 0=bottom→top, 90=left→right). Default 135.",
      parseFiniteOpt("--angle"),
    )
    .option(
      "--shape <rect|squircle>",
      "Corner shape. Default rect.",
      parseShapeOpt,
    )
    .option("--out-dir <dir>", "Output directory (default: cwd)")
    .option("--out-name <name>", "Output filename (default: backplate-<size>.png)")
    .option("--log <path>", "Path to log JSONL file")
    .option("--overwrite", "Overwrite an existing output file");

  cmd.action(async (opts: BackplateCliOpts) => {
    const sdk = new GptImg();
    const result = await sdk.backplate(
      {
        size: opts.size,
        content: opts.content,
        radius: opts.radius,
        from: opts.from,
        to: opts.to,
        angle: opts.angle,
        shape: opts.shape,
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
