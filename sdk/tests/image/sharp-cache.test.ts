// On Windows, libvips's cache keeps an image's file open after reading it, so
// a file the SDK wrote and read back could not be renamed or deleted. macOS
// shows no lock, so this holds the setting itself.
import sharpDirect from "sharp";
import { describe, expect, it } from "vitest";
import "../../src/index.ts";

describe("sharp as the SDK loads it", () => {
  it("keeps no file open in libvips's cache", () => {
    expect(sharpDirect.cache()).toMatchObject({ files: { max: 0 }, items: { max: 0 } });
  });
});
