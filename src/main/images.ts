// The gptimg-image: protocol. The renderer loads every picture through it:
// only files inside the sessions folder, the staging folder, or files the
// user picked or dropped this launch are served. `?w=` returns a copy decoded
// at that width (volume-handling-conventions: decode at the size shown).
import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";
import sharp from "sharp";
import { IMAGE_SCHEME } from "../shared/api.ts";
import { isInside } from "./sessions.ts";
import { IMAGE_INPUT_FORMATS } from "gptimgsdk/types";

const MAX_THUMB_WIDTH = 2048;
// Opening a long chat asks for every picture at once, since every print mounts. Measured on a
// 10-core Mac with 40 PNGs at the generated sizes (1024 to 1536 px): one at a time took 2.8 to
// 3.6 s at the print width and 1.2 s at 240 px, with the process near 120% CPU, barely more than
// one core, because PNG decoding and encoding are single-threaded inside sharp. Two at a time took
// 1.7 to 1.9 s, three 1.3 s, four 1.1 s. Three leaves one of libuv's four threads, which sharp
// shares with file reads, free; each encode holds one decoded image, about 6 MB at these sizes.
const ENCODES_AT_ONCE = 3;

export class ImageAccess {
  readonly #picked = new Set<string>();
  #encoding = 0;
  readonly #waiting: Array<() => void> = [];

  readonly #roots: () => string[];

  constructor(roots: () => string[]) {
    this.#roots = roots;
  }

  /** Allows a file the user chose (picker or drop) when it is an image the SDK reads. */
  async register(path: string): Promise<boolean> {
    const absolute = resolve(path);
    if (!isImagePath(absolute)) return false;
    try {
      if (!(await stat(absolute)).isFile()) return false;
    } catch {
      return false;
    }
    this.#picked.add(absolute);
    return true;
  }

  allowed(path: string): boolean {
    const absolute = resolve(path);
    if (this.#picked.has(absolute)) return true;
    return this.#roots().some((root) => root !== "" && isInside(root, absolute));
  }

  async #encode(path: string, width?: number): Promise<Buffer | null> {
    try {
      let image = sharp(path).rotate();
      if (width !== undefined) image = image.resize({ width, withoutEnlargement: true });
      return await image.png().toBuffer();
    } catch {
      return null;
    }
  }

  /** Runs up to ENCODES_AT_ONCE jobs, starting the rest in arrival order as each finishes. */
  async #queued<T>(job: () => Promise<T>): Promise<T> {
    if (this.#encoding < ENCODES_AT_ONCE) this.#encoding++;
    else await new Promise<void>((start) => this.#waiting.push(start));
    try {
      return await job();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#encoding--;
    }
  }

  // No thumbnail cache (rejected-mechanisms-conventions, Performance machinery for unmeasured
  // scale). Measured in Electron with 40 pictures at the generated sizes: a chat's prints stay
  // mounted and are asked for once while it is open, so a cache scoped to the open chat saved
  // nothing; switching to another chat and back asks for all 40 again, since Chromium had
  // dropped them, and only a cache kept across every chat visited, bounded by nothing but a cap,
  // would answer that. Returning to a chat re-encodes its pictures as opening it did.
  #thumb(path: string, width: number): Promise<Buffer | null> {
    return this.#queued(() => this.#encode(path, width));
  }

  /** Checked asynchronous PNG conversion. */
  async png(path: string, width?: number): Promise<Buffer | null> {
    if (!this.allowed(path)) return null;
    const absolute = resolve(path);
    try {
      if (width !== undefined) {
        if (!Number.isFinite(width) || width <= 0) return null;
        return await this.#thumb(absolute, Math.max(1, Math.min(MAX_THUMB_WIDTH, Math.round(width))));
      }
      return await this.#queued(() => this.#encode(absolute));
    } catch {
      return null;
    }
  }

  install(): void {
    protocol.handle(IMAGE_SCHEME, async (request) => {
      const url = new URL(request.url);
      const path = decodeURIComponent(url.pathname.replace(/^\//, ""));
      if (!this.allowed(path)) return new Response(null, { status: 403 });
      const width = Number(url.searchParams.get("w"));
      try {
        if (Number.isFinite(width) && width > 0) {
          const png = await this.#thumb(path, Math.max(1, Math.min(MAX_THUMB_WIDTH, Math.round(width))));
          if (png) return new Response(new Uint8Array(png), { headers: { "content-type": "image/png", "cache-control": "no-cache" } });
        }
        return await net.fetch(pathToFileURL(path).toString());
      } catch {
        return new Response(null, { status: 404 });
      }
    });
  }
}

/** The file extensions of the formats OpenAI takes as an attached image, from the SDK's rule. */
export const IMAGE_EXTENSIONS: readonly string[] = IMAGE_INPUT_FORMATS.flatMap((entry) => entry.extensions);

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.includes(extname(path).slice(1).toLowerCase());
}

export function registerImageScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}
