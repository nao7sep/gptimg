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

const CACHE_LIMIT = 300;
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
  readonly #thumbs = new Map<string, Buffer>();
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

  /** A repeat that starts after the first finished finds its cached copy; one running alongside it encodes again. */
  async #thumb(path: string, width: number): Promise<Buffer | null> {
    const info = await stat(path);
    const key = `${path}\0${width}\0${info.mtimeMs}\0${info.size}`;
    return this.#queued(async () => {
      const hit = this.#thumbs.get(key);
      if (hit) {
        this.#thumbs.delete(key);
        this.#thumbs.set(key, hit);
        return hit;
      }
      const png = await this.#encode(path, width);
      if (png) {
        this.#thumbs.set(key, png);
        if (this.#thumbs.size > CACHE_LIMIT) this.#thumbs.delete(this.#thumbs.keys().next().value!);
      }
      return png;
    });
  }

  /** Checked asynchronous PNG conversion. Full-size clipboard images are never cached. */
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
