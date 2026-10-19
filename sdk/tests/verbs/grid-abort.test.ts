import { mkdtemp, readdir, rm } from "node:fs/promises";
import { done } from "../helpers/results.ts";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GptImg } from "../../src/index.ts";

const decode = vi.hoisted(() => ({
  input: undefined as string | undefined,
  entered: undefined as (() => void) | undefined,
  wait: undefined as Promise<void> | undefined,
}));

// Run sharp's actual decode and hold only its settlement at the last tile.
// This exercises both the normal decode and the real unreadable-input branch.
vi.mock("sharp", async (importOriginal) => {
  const original = await importOriginal<typeof import("sharp")>();
  const realSharp = original.default;
  const controlledSharp = ((...args: Parameters<typeof realSharp>) => {
    const image = realSharp(...args);
    if (args[0] === decode.input && decode.wait) {
      const toBuffer = image.toBuffer.bind(image);
      image.toBuffer = (async (...bufferArgs: Parameters<typeof image.toBuffer>) => {
        try {
          const result = await toBuffer(...bufferArgs);
          decode.entered?.();
          await decode.wait;
          return result;
        } catch (error) {
          decode.entered?.();
          await decode.wait;
          throw error;
        }
      }) as typeof image.toBuffer;
    }
    return image;
  }) as typeof realSharp;
  Object.assign(controlledSharp, realSharp);
  return { ...original, default: controlledSharp };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("public grid cancellation after its final tile", () => {
  let tmp: string;
  let first: string;
  let last: string;
  let missing: string;
  let sdk: GptImg;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-grid-abort-"));
    sdk = new GptImg({ modelsDir: path.join(tmp, "models") });
    first = path.join(tmp, "first.png");
    last = path.join(tmp, "last.png");
    missing = path.join(tmp, "missing.png");
    for (const input of [first, last]) {
      await sharp({ create: { width: 8, height: 8, channels: 4, background: "#cc3366" } }).png().toFile(input);
    }
  });

  afterEach(async () => {
    decode.input = undefined;
    decode.entered = undefined;
    decode.wait = undefined;
    await rm(tmp, { recursive: true, force: true });
  });

  it.each(["decoded", "unreadable"] as const)(
    "rejects cancellation after the final %s tile and publishes nothing",
    async (kind) => {
      const ctrl = new AbortController();
      const entered = deferred();
      const released = deferred();
      decode.input = kind === "decoded" ? last : missing;
      decode.entered = entered.resolve;
      decode.wait = released.promise;
      const operation = sdk.grid(
        { inputs: [first, decode.input], cell: 8, gap: 0, outName: "sheet" },
        { signal: ctrl.signal },
      );
      const rejected = expect(operation).rejects.toMatchObject({ code: "cancelled" });
      void rejected.catch(() => undefined);
      try {
        await entered.promise;
        ctrl.abort(new Error("stop grid"));
        released.resolve();
        await rejected;
        expect((await readdir(tmp)).filter((name) => name.startsWith("sheet"))).toEqual([]);
      } finally {
        released.resolve();
        await operation.catch(() => undefined);
      }
    },
  );

  it.each(["decoded", "unreadable"] as const)(
    "still publishes the successful grid after the final %s tile when not cancelled",
    async (kind) => {
      const final = kind === "decoded" ? last : missing;
      const result = done(await sdk.grid({ inputs: [first, final], cell: 8, gap: 0, outName: "sheet" }));
      expect(result).toMatchObject({
        output: path.join(tmp, "sheet.png"),
        count: 2,
        placed: kind === "decoded" ? 2 : 1,
        skipped: kind === "decoded" ? [] : [expect.objectContaining({ input: missing, code: "fs.notFound" })],
      });
      const metadata = await sharp(result.output).metadata();
      expect([metadata.width, metadata.height]).toEqual(kind === "decoded" ? [16, 8] : [8, 8]);
      expect(metadata.format).toBe("png");
    },
  );
});
