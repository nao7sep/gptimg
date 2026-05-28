import { InvalidArgumentError, Option, type Command } from "commander";
import { GptImg } from "../../gptimg.js";
import { getAbortSignal } from "../abort.js";
import { emit } from "../output.js";
import { ensureModel } from "../../local/models/fetch.js";
import { BIREFNET } from "../../local/models/registry.js";
import { defaultModelsDir } from "../../internal/paths.js";
import { DEFAULT_PROFILE_DIR } from "../../internal/paths.js";
import type { MaskMethod } from "../../types.js";

const KEY_RE = /^#[0-9a-fA-F]{6}$/;

function parseKeyOpt(v: string): string {
  if (v === "auto" || v === "from-sidecar") return v;
  if (KEY_RE.test(v)) return v;
  throw new InvalidArgumentError("must be 'auto', 'from-sidecar', or '#rrggbb'");
}

function parseIntOpt(name: string) {
  return (v: string): number => {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) throw new InvalidArgumentError(`${name}: not a number`);
    return n;
  };
}

interface MaskCliOpts {
  in: string;
  method?: MaskMethod;
  key?: string;
  preserveInterior?: boolean;
  borderSample?: number;
  dryRun?: boolean;
  outDir?: string;
  outName?: string;
  recipe?: string;
  log?: string;
  overwrite?: boolean;
}

export function registerMask(program: Command): void {
  const cmd = program
    .command("mask")
    .description("Produce a grayscale alpha mask from an image (no compositing).")
    .requiredOption("--in <path>", "Input image path")
    .addOption(
      new Option("--method <name>", "Mask producer")
        .choices(["chroma", "ai"])
        .default("chroma"),
    )
    .option(
      "--key <value>",
      "auto | from-sidecar | #rrggbb (chroma method only)",
      parseKeyOpt,
    )
    .option(
      "--preserve-interior",
      "Keep interior key-colored regions opaque (e.g. donut hole). Chroma method only.",
    )
    .option(
      "--border-sample <px>",
      "Border depth for --key auto",
      parseIntOpt("--border-sample"),
    )
    .option("--dry-run", "Compute and emit stats without writing the mask file")
    .option("--out-dir <dir>", "Output directory (default: same as input)")
    .option("--out-name <name>", "Output filename (default: <input-stem>-mask.png)")
    .option("--recipe <path>", "Path to recipe JSON file")
    .option("--log <path>", "Path to log JSONL file")
    .option("--overwrite", "Overwrite an existing mask file");

  cmd.action(async (opts: MaskCliOpts) => {
    const sdk = new GptImg();
    const result = await sdk.mask(
      {
        in: opts.in,
        method: opts.method,
        key: opts.key,
        preserveInterior: opts.preserveInterior,
        borderSample: opts.borderSample,
        dryRun: opts.dryRun,
        outDir: opts.outDir,
        outName: opts.outName,
        recipe: opts.recipe,
        log: opts.log,
        overwrite: opts.overwrite,
      },
      { signal: getAbortSignal() },
    );
    emit(result);
  });

  cmd
    .command("install-model")
    .description(
      "Pre-fetch the AI mask model into the cache so the first --method ai call is offline-fast.",
    )
    .action(async () => {
      const cacheDir = defaultModelsDir(DEFAULT_PROFILE_DIR);
      const finalPath = await ensureModel(BIREFNET, cacheDir, {
        signal: getAbortSignal(),
      });
      emit({ model: BIREFNET.name, path: finalPath });
    });
}
