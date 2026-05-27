import { InvalidArgumentError, Option, type Command } from "commander";
import { GptImg } from "../../gptimg.js";
import { getAbortSignal } from "../abort.js";
import { emit } from "../output.js";
import type { ChromaMetric, ChromaMode } from "../../types.js";

function parseKeyOpt(v: string): string {
  if (v === "auto" || v === "from-sidecar") return v;
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
  throw new InvalidArgumentError("must be 'auto', 'from-sidecar', or '#rrggbb'");
}

interface InspectCliOpts {
  in: string;
  mode?: ChromaMode;
  key?: string;
  innerThreshold?: number;
  outerThreshold?: number;
  metric?: ChromaMetric;
  borderSample?: number;
  edgeBandDilate?: number;
  edgeBandErode?: number;
  strictConfidence?: number;
  log?: string;
}

function parseIntOpt(name: string) {
  return (v: string): number => {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) throw new InvalidArgumentError(`${name}: not a number`);
    return n;
  };
}
function parseFloatOpt(name: string) {
  return (v: string): number => {
    const n = parseFloat(v);
    if (Number.isNaN(n)) throw new InvalidArgumentError(`${name}: not a number`);
    return n;
  };
}

export function registerInspect(program: Command): void {
  const cmd = program
    .command("inspect")
    .description("Detect chroma regions and report stats only (no writes)")
    .requiredOption("--in <path>", "Input image path")
    .addOption(
      new Option("--mode <mode>", "Detection mode")
        .choices(["outer", "all"])
        .default("outer"),
    )
    .option(
      "--key <value>",
      "auto | from-sidecar | #rrggbb",
      parseKeyOpt,
      "auto",
    )
    .option(
      "--inner-threshold <n>",
      "Distance below which pixels are background",
      parseFloatOpt("--inner-threshold"),
    )
    .option(
      "--outer-threshold <n>",
      "Distance above which pixels are subject",
      parseFloatOpt("--outer-threshold"),
    )
    .addOption(
      new Option("--metric <name>", "Distance metric")
        .choices(["lab_de76"])
        .default("lab_de76"),
    )
    .option(
      "--border-sample <px>",
      "Border depth for auto key detection",
      parseIntOpt("--border-sample"),
    )
    .option(
      "--edge-band-dilate <px>",
      "Dilate radius for the edge band",
      parseIntOpt("--edge-band-dilate"),
    )
    .option(
      "--edge-band-erode <px>",
      "Erode radius for the edge band",
      parseIntOpt("--edge-band-erode"),
    )
    .option(
      "--strict-confidence <n>",
      "Higher confidence gate for region acceptance (0..1)",
      parseFloatOpt("--strict-confidence"),
    )
    .option("--log <path>", "Path to log JSONL file");

  cmd.action(async (opts: InspectCliOpts) => {
    const sdk = new GptImg();
    const edgeBand =
      opts.edgeBandDilate !== undefined || opts.edgeBandErode !== undefined
        ? {
            dilate: opts.edgeBandDilate ?? 2,
            erode: opts.edgeBandErode ?? 2,
          }
        : undefined;
    const result = await sdk.inspect(
      {
        in: opts.in,
        mode: opts.mode,
        key: opts.key,
        innerThreshold: opts.innerThreshold,
        outerThreshold: opts.outerThreshold,
        metric: opts.metric,
        borderSample: opts.borderSample,
        edgeBand,
        strictConfidence: opts.strictConfidence,
        log: opts.log,
      },
      { signal: getAbortSignal() },
    );
    emit(result);
  });
}
