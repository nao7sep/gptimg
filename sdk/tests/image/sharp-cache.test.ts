// On Windows, libvips's cache keeps an image's file open after reading it, so
// a file the SDK wrote and read back could not be renamed or deleted. macOS
// shows no lock, so this holds the setting itself.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharpDirect from "sharp";
import { describe, expect, it } from "vitest";
import "../../src/index.ts";

describe("sharp as the SDK loads it", () => {
  it("keeps no file open in libvips's cache", () => {
    expect(sharpDirect.cache()).toMatchObject({ files: { max: 0 } });
  });

  it("is the only way the SDK's source loads sharp, so no module reads files before the cache is off", () => {
    const src = fileURLToPath(new URL("../../src/", import.meta.url));
    const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts") && path.normalize(f) !== path.normalize("image/sharp.ts"));
    const direct = files.filter((f) => /^import (?!type )[^;]*from "sharp";/m.test(readFileSync(path.join(src, f), "utf8")));
    expect(direct).toEqual([]);
  });
});
