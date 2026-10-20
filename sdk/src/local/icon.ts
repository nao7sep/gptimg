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

import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { IconIcns, IconIco } from "@shockpkg/icon-encoder";
import { fsError, GptImgError, processingError, throwIfAborted } from "../errors.ts";
import { decodeImage, encodeImage, inputImageError, readImageSize } from "../image/bridge.ts";
import { readSourceMetadata, type SourceMetadata } from "../image/source-metadata.ts";
import { publishStaged, stageFile, syncDirectory } from "../internal/atomic-file.ts";
import { refuse } from "../refusal.ts";
import type { Logger } from "../events/index.ts";
import type { PngEncodingArgs } from "../types.ts";

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
// Tauri decodes the first ICO entry as its default live window icon instead of
// selecting the closest frame. Put 32 first so Windows taskbars at common
// 100-150% scaling downsample a native-size frame instead of enlarging 16 px.
// The remaining entries cover every Windows 11 AppList target size from
// 100-400% scaling; 128 is retained for legacy and large-icon consumers.
// Windows shell consumers select entries by dimensions, not directory order.
const ICO_SIZES: readonly number[] = [
  32, 16, 20, 24, 30, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256,
];

/** Loose sized-PNG set emitted when `pngs` is set. */
const PNG_SET_SIZES: readonly number[] = [16, 32, 48, 64, 128, 256, 512, 1024];

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

export interface IconRunArgs extends PngEncodingArgs {
  in: string;
  outDir: string;
  name?: string;
  pngs?: boolean;
  /** Replace existing files; otherwise each publication is no-clobber. */
  overwrite?: boolean;
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
  opts: { signal?: AbortSignal | undefined; logger?: Logger } = {},
): Promise<IconRunResult> {
  const { signal } = opts;
  throwIfAborted(signal);

  const name = args.name ?? ICON_DEFAULTS.name;
  const pngs = args.pngs ?? ICON_DEFAULTS.pngs;

  const { width, height } = await readImageSize(args.in, "icon");
  if (width !== height) {
    throw new GptImgError(
      "args.invalid",
      `icon: master must be square; got ${width}x${height}. Use \`trim --square\` or \`backplate\`.`,
      { details: { field: "in", constraint: "square image" } },
    );
  }
  if (width < MIN_MASTER) {
    throw new GptImgError(
      "args.invalid",
      `icon: master must be at least ${MIN_MASTER}x${MIN_MASTER}; got ${width}x${height}.`,
      { details: { field: "in", constraint: "at least the master size" } },
    );
  }
  throwIfAborted(signal);

  const plan = planIconOutputs(args.outDir, name, pngs);

  // Decode the master once; every entry is a downscale of these bytes. Cache
  // per size so overlapping icns/ico/png-set sizes render only once.
  let master: Buffer;
  let source: SourceMetadata;
  try {
    master = await decodeImage(args.in).ensureAlpha().png().toBuffer();
    source = await readSourceMetadata(args.in);
  } catch (err) {
    throw inputImageError(err, "icon: failed to decode", args.in);
  }

  const cache = new Map<number, Promise<Buffer>>();
  const render = (size: number): Promise<Buffer> => {
    let p = cache.get(size);
    if (!p) {
      p = encodeImage(
        decodeImage(master).resize(size, size, { fit: "fill", kernel: "lanczos3" }),
        args,
        "icon",
        source,
      );
      cache.set(size, p);
    }
    return p;
  };

  // Encode the whole set before writing anything, so a failure to build any
  // rendition leaves the folder untouched.
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
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

    files.push({ path: plan.icns, bytes: icns.encode() });
    files.push({ path: plan.ico, bytes: ico.encode() });
    files.push({ path: plan.png, bytes: await render(MASTER_SIZE) });
    for (const { size, path: p } of plan.pngSet) {
      throwIfAborted(signal);
      files.push({ path: p, bytes: await render(size) });
    }
  } catch (err) {
    throw processingError(err, "icon: failed to build icons from", args.in, "none");
  }

  // Publish the set together: every file is staged beside its target first, so
  // a failure to write any leaves the folder as it was; then each is renamed
  // in. A failure or a cancellation while renaming removes the files this call
  // created, never a file that existed before it (an overwrite has already
  // replaced those), so old and new sizes mix only if a rename itself fails.
  const overwrite = args.overwrite ?? false;
  const staged: Array<{ path: string; temp: string }> = [];
  try {
    for (const file of files) {
      throwIfAborted(signal);
      staged.push({ path: file.path, temp: await stageFile(file.path, file.bytes) });
    }
  } catch (err) {
    for (const { temp } of staged) await unlink(temp).catch(() => undefined);
    throw processingError(err, "icon: failed to stage icons from", args.in, "none");
  }
  const created: string[] = [];
  let replaced = false;
  try {
    for (const [i, file] of staged.entries()) {
      throwIfAborted(signal);
      const existed = existsSync(file.path);
      try {
        await publishStaged(file.temp, file.path, { overwrite });
      } catch (err) {
        if (!overwrite && (err as NodeJS.ErrnoException).code === "EEXIST") {
          refuse("output.exists", `Output exists: ${file.path}. Set overwrite: true to allow.`, { subject: file.path });
        }
        throw fsError(err, "icon: failed to publish", file.path, "unknown");
      }
      if (existed) replaced = true;
      else created.push(file.path);
      opts.logger?.progress("write", i + 1, staged.length, "renditions");
    }
    for (const dir of new Set(staged.map((file) => path.dirname(file.path)))) await syncDirectory(dir);
  } catch (err) {
    for (const { temp } of staged) await unlink(temp).catch(() => undefined);
    for (const filePath of created) await unlink(filePath).catch(() => undefined);
    const failure = processingError(err, "icon: failed to publish icons from", args.in);
    // With the created files removed, only replaced files are left changed.
    throw failure instanceof GptImgError ? failure.withEffect(replaced ? "unknown" : "none") : failure;
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
