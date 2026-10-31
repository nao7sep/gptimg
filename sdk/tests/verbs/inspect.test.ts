import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GptImg } from "../../src/index.ts";
import { done } from "../helpers/results.ts";

describe("inspect", () => {
  let tmp: string;
  const sdk = new GptImg();

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-inspect-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const solid = (channels: 3 | 4, alpha = 1) =>
    sharp({ create: { width: 12, height: 8, channels, background: { r: 0, g: 128, b: 255, alpha } } });

  it("reports an opaque RGB image's facts without a record", async () => {
    const file = path.join(tmp, "plain.png");
    await solid(3).png().toFile(file);
    const result = done(await sdk.inspect({ in: file }));
    expect(result).toMatchObject({
      input: file,
      format: "png",
      extensionMatches: true,
      width: 12,
      height: 8,
      channels: 3,
      hasAlpha: false,
      opaque: true,
      bitDepth: 8,
      colorSpace: "srgb",
      pages: 1,
      orientation: null,
      record: null,
    });
    expect(result.fileBytes).toBeGreaterThan(0);
  });

  it("tells an alpha channel that is fully opaque from one with translucent pixels", async () => {
    const opaque = path.join(tmp, "opaque.png");
    const translucent = path.join(tmp, "translucent.png");
    await solid(4, 1).png().toFile(opaque);
    await solid(4, 0.5).png().toFile(translucent);
    expect(done(await sdk.inspect({ in: opaque }))).toMatchObject({ hasAlpha: true, opaque: true });
    expect(done(await sdk.inspect({ in: translucent }))).toMatchObject({ hasAlpha: true, opaque: false });
  });

  it("flags bytes whose format the extension does not name, and accepts an alias extension", async () => {
    const mislabelled = path.join(tmp, "photo.png");
    const alias = path.join(tmp, "photo2.jpeg");
    await solid(3).jpeg().toFile(mislabelled);
    await solid(3).jpeg().toFile(alias);
    expect(done(await sdk.inspect({ in: mislabelled }))).toMatchObject({ format: "jpeg", extensionMatches: false });
    expect(done(await sdk.inspect({ in: alias }))).toMatchObject({ format: "jpeg", extensionMatches: true });
  });

  it("reads the sidecar beside a paid image, with the chroma key it recorded", async () => {
    const file = path.join(tmp, "star-original.png");
    await solid(3).png().toFile(file);
    await writeFile(
      path.join(tmp, "star-original.json"),
      JSON.stringify({
        formatVersion: 1, kind: "generate", writer: { name: "gptimgsdk", version: "1.0.0" },
        request: { prompt: "a star", n: 1, chroma: { color: "#00ff00" } }, response: {},
        files: [{ index: 1, name: "star-original.png", sha256: "0".repeat(64), format: "png" }],
      }),
    );
    expect(done(await sdk.inspect({ in: file })).record).toEqual({
      path: path.join(tmp, "star-original.json"),
      status: "readable",
      kind: "generate",
      formatVersion: 1,
      writer: { name: "gptimgsdk", version: "1.0.0" },
      chromaKey: "#00ff00",
    });
  });

  it("reports an unreadable sidecar by its code instead of failing", async () => {
    const file = path.join(tmp, "x.png");
    await solid(3).png().toFile(file);
    await writeFile(path.join(tmp, "x.json"), "{ not json");
    expect(done(await sdk.inspect({ in: file })).record).toMatchObject({ status: "unreadable", code: "sidecar.malformed" });
  });

  it("fails fs.notFound for a missing file and image.undecodable for one that is not an image", async () => {
    const missing = path.join(tmp, "nope.png");
    await expect(sdk.inspect({ in: missing })).rejects.toMatchObject({ code: "fs.notFound", subject: missing });
    const text = path.join(tmp, "text.png");
    await writeFile(text, "not an image");
    await expect(sdk.inspect({ in: text })).rejects.toMatchObject({ code: "image.undecodable" });
  });

  it("refuses a relative path and stops on an aborted signal", async () => {
    await expect(sdk.inspect({ in: "relative.png" })).rejects.toMatchObject({ code: "args.invalid", details: { field: "in" } });
    const file = path.join(tmp, "plain.png");
    await solid(3).png().toFile(file);
    const controller = new AbortController();
    controller.abort();
    await expect(sdk.inspect({ in: file }, { signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
  });
});
