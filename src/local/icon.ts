/**
 * Icon: pack a square master PNG into the platform-agnostic icon artifacts that
 * every desktop toolchain consumes — `icon.icns` (macOS), `icon.ico` (Windows),
 * and a 1024² `icon.png` master copy. Optionally also a loose sized-PNG set
 * (`icon-16.png` … `icon-1024.png`) for Linux/.NET/web.
 *
 * The byte-level container encoding is delegated to `@shockpkg/icon-encoder`;
 * sharp renders each required pixel size from the master with the same lanczos3
 * resample the rest of the toolkit uses. Per-toolchain *placement* (Electron's
 * `build/`, Tauri's `src-tauri/icons/` names, .NET's `<ApplicationIcon>`) is not
 * this verb's concern: the bytes are identical everywhere, only the destination
 * differs, which the caller arranges.
 */

import path from "node:path";
import sharp from "sharp";
import { IconIcns, IconIco } from "@shockpkg/icon-encoder";
import { LocalOpError, toAbortError } from "../errors.js";
import { writeOutputBytes } from "../internal/output-files.js";

export const ICON_DEFAULTS = {
  name: "icon",
  pngs: false,
} as const;

/** Smallest accepted master edge: the largest entry we emit is native, not upscaled. */
const MIN_MASTER = 1024;

/** The master PNG copy and the icns ic10 entry both want this edge. */
const MASTER_SIZE = 1024;

/**
 * Distinct pixel sizes packed into the `.icns`, each mapped to the OSType codes
 * that share that pixel dimension (a `@2x` retina type is the same pixels as
 * the next `@1x` size up). One PNG is rendered per row and reused for every
 * code on it. Codes per `@shockpkg/icon-encoder`'s modern PNG-based formats.
 */
const ICNS_ENTRIES: ReadonlyArray<{ size: number; types: readonly string[] }> = [
  { size: 16, types: ["ic04"] },
  { size: 32, types: ["ic05", "ic11"] }, // ic11 = 16@2x
  { size: 64, types: ["ic12"] }, //          ic12 = 32@2x
  { size: 128, types: ["ic07"] },
  { size: 256, types: ["ic08", "ic13"] }, // ic13 = 128@2x
  { size: 512, types: ["ic09", "ic14"] }, // ic14 = 256@2x
  { size: 1024, types: ["ic10"] }, //        ic10 = 512@2x
];

/**
 * `.ico` entry sizes. ≤128 are stored as 32-bit BMP and 256 as embedded PNG —
 * the classic, maximally-compatible Windows layout (PNG-in-ICO at 256 is
 * read by every Windows since Vista; small sizes stay BMP for old shells).
 */
const ICO_SIZES: readonly number[] = [16, 24, 32, 48, 64, 128, 256];

/** Loose sized-PNG set emitted when `pngs` is set. */
const PNG_SET_SIZES: readonly number[] = [16, 32, 48, 64, 128, 256, 512, 1024];

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw toAbortError(signal.reason);
}

export interface IconPlan {
  icns: string;
  ico: string;
  png: string;
  pngSet: Array<{ size: number; path: string }>;
  /** Every planned output path, in write order. */
  all: string[];
}

/**
 * Compute the output file paths for a given dir/name. Pure — shared by the SDK
 * layer's overwrite check and by `runIcon`, so the naming lives in one place.
 */
export function planIconOutputs(
  outDir: string,
  name: string,
  pngs: boolean,
): IconPlan {
  if (name.length === 0 || path.basename(name) !== name) {
    throw new LocalOpError(
      "args.invalid",
      `icon: name must be a plain filename stem (no path separators); got "${name}".`,
    );
  }
  const icns = path.join(outDir, `${name}.icns`);
  const ico = path.join(outDir, `${name}.ico`);
  const png = path.join(outDir, `${name}.png`);
  const pngSet = pngs
    ? PNG_SET_SIZES.map((size) => ({
        size,
        path: path.join(outDir, `${name}-${size}.png`),
      }))
    : [];
  return { icns, ico, png, pngSet, all: [icns, ico, png, ...pngSet.map((p) => p.path)] };
}

export interface IconRunArgs {
  in: string;
  outDir: string;
  name?: string;
  pngs?: boolean;
}

export interface IconRunResult {
  outputs: string[];
  icns: string;
  ico: string;
  png: string;
  pngSet: Array<{ size: number; path: string }>;
  sourceWidth: number;
  sourceHeight: number;
}

export async function runIcon(
  args: IconRunArgs,
  opts: { signal?: AbortSignal | undefined } = {},
): Promise<IconRunResult> {
  const { signal } = opts;
  throwIfAborted(signal);

  const name = args.name ?? ICON_DEFAULTS.name;
  const pngs = args.pngs ?? ICON_DEFAULTS.pngs;

  let meta;
  try {
    meta = await sharp(args.in).metadata();
  } catch (err) {
    throw new LocalOpError(
      "image.decodeFailed",
      `icon: failed to read ${args.in}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  const { width, height } = meta;
  if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) {
    throw new LocalOpError(
      "image.noContent",
      `icon: could not determine dimensions of ${args.in}.`,
    );
  }
  if (width !== height) {
    throw new LocalOpError(
      "args.invalid",
      `icon: master must be square; got ${width}x${height}. Use \`trim --square\` or \`backplate\`.`,
    );
  }
  if (width < MIN_MASTER) {
    throw new LocalOpError(
      "args.invalid",
      `icon: master must be at least ${MIN_MASTER}x${MIN_MASTER}; got ${width}x${height}.`,
    );
  }
  throwIfAborted(signal);

  const plan = planIconOutputs(args.outDir, name, pngs);

  // Decode the master once; every entry is a downscale of these bytes. Cache
  // per size so overlapping icns/ico/png-set sizes render only once.
  let master: Buffer;
  try {
    master = await sharp(args.in).ensureAlpha().png().toBuffer();
  } catch (err) {
    throw new LocalOpError(
      "image.decodeFailed",
      `icon: failed to decode ${args.in}: ${(err as Error).message}`,
      { cause: err },
    );
  }

  const cache = new Map<number, Promise<Buffer>>();
  const render = (size: number): Promise<Buffer> => {
    let p = cache.get(size);
    if (!p) {
      p = sharp(master)
        .resize(size, size, { fit: "fill", kernel: "lanczos3" })
        .png()
        .toBuffer();
      cache.set(size, p);
    }
    return p;
  };

  try {
    const icns = new IconIcns();
    icns.toc = true;
    for (const { size, types } of ICNS_ENTRIES) {
      await icns.addFromPng(await render(size), types, false);
      throwIfAborted(signal);
    }

    const ico = new IconIco();
    for (const size of ICO_SIZES) {
      await ico.addFromPng(await render(size), size >= 256, false);
      throwIfAborted(signal);
    }

    await writeOutputBytes(plan.icns, icns.encode());
    await writeOutputBytes(plan.ico, ico.encode());
    await writeOutputBytes(plan.png, await render(MASTER_SIZE));
    for (const { size, path: p } of plan.pngSet) {
      await writeOutputBytes(p, await render(size));
    }
  } catch (err) {
    if ((err as { errorType?: string }).errorType) throw err; // already a LocalOpError
    throw new LocalOpError(
      "image.writeFailed",
      `icon: failed to build icons from ${args.in}: ${(err as Error).message}`,
      { cause: err },
    );
  }

  return {
    outputs: plan.all,
    icns: plan.icns,
    ico: plan.ico,
    png: plan.png,
    pngSet: plan.pngSet,
    sourceWidth: width,
    sourceHeight: height,
  };
}
