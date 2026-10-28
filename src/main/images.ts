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

const CACHE_LIMIT = 300;
const MAX_THUMB_WIDTH = 2048;

export class ImageAccess {
  readonly #picked = new Set<string>();
  readonly #thumbs = new Map<string, Buffer>();
  // One image encodes at a time (serial by default); sharp spreads each across its own threads.
  #queue: Promise<unknown> = Promise.resolve();

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

  #serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(job, job);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** A repeated request waits its turn and then finds the copy the first one cached. */
  async #thumb(path: string, width: number): Promise<Buffer | null> {
    const info = await stat(path);
    const key = `${path}\0${width}\0${info.mtimeMs}\0${info.size}`;
    return this.#serial(async () => {
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
      return await this.#serial(() => this.#encode(absolute));
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

/** The formats OpenAI takes as a reference image. Main never loads the SDK itself; that is the worker's. */
export const REFERENCE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"] as const;

export function isImagePath(path: string): boolean {
  return (REFERENCE_EXTENSIONS as readonly string[]).includes(extname(path).toLowerCase());
}

export function registerImageScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}
