// verify: a published paid image checked against its sidecar before a consumer
// relies on it (sdk-conventions, *Verify what was written*). Findings are
// results; only an unreadable image is an error.
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GptImg } from "../../src/index.ts";
import { done } from "../helpers/results.ts";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "green-disk.png");

describe("verify", () => {
  let tmp: string;
  let image: string;
  let sha256: string;
  const img = new GptImg();

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-verify-"));
    image = path.join(tmp, "raw.png");
    await copyFile(FIXTURE, image);
    sha256 = createHash("sha256").update(await readFile(image)).digest("hex");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function sidecar(name: string, entry: Record<string, unknown>, formatVersion = 1): Promise<void> {
    await writeFile(path.join(tmp, "raw.json"), JSON.stringify({ formatVersion, request: { prompt: "p", n: 1 }, response: {}, files: [{ index: 1, name, sha256, format: "png", ...entry }] }));
  }

  it("passes an image whose sidecar names it, carries its digest and records its format", async () => {
    await sidecar("raw.png", {});
    const result = done(await img.verify({ in: image }));
    expect(result).toMatchObject({ ok: true, findings: [], sidecarPath: path.join(tmp, "raw.json"), record: { kind: "generate" } });
  });

  it.each([1, 2])("chooses a later matching name and digest in format %s", async (formatVersion) => {
    const record = {
      formatVersion,
      ...(formatVersion === 2 && { kind: "generate", writer: { name: "gptimgsdk", version: "0.1.0" } }),
      request: { prompt: "p", n: 2 }, response: {},
      files: [
        { index: 1, name: "other.png", sha256, format: "webp" },
        { index: 2, name: "raw.png", sha256, format: "png" },
      ],
    };
    await writeFile(path.join(tmp, "raw.json"), JSON.stringify(record));
    expect(done(await img.verify({ in: image }))).toMatchObject({ ok: true, findings: [] });
  });

  it("finds a renamed raw whose files[].name was not updated, and a replaced image", async () => {
    await sidecar("old-name.png", {});
    expect(done(await img.verify({ in: image })).findings.map((f) => f.code)).toEqual(["sidecar.nameMismatch"]);
    await sidecar("raw.png", { sha256: "0".repeat(64) });
    expect(done(await img.verify({ in: image })).findings.map((f) => f.code)).toEqual(["sidecar.hashMismatch"]);
  });

  it("finds a missing, unreadable or newer sidecar, and a format the bytes do not have", async () => {
    expect(done(await img.verify({ in: image })).findings.map((f) => f.code)).toEqual(["sidecar.missing"]);
    await writeFile(path.join(tmp, "raw.json"), "{ nope");
    expect(done(await img.verify({ in: image })).findings.map((f) => f.code)).toEqual(["sidecar.malformed"]);
    await writeFile(path.join(tmp, "raw.json"), JSON.stringify({ formatVersion: 99 }));
    expect(done(await img.verify({ in: image })).findings.map((f) => f.code)).toEqual(["sidecar.newerFormat"]);
    await sidecar("raw.png", { format: "webp" });
    expect(done(await img.verify({ in: image })).findings.map((f) => f.code)).toEqual(["image.formatMismatch"]);
  });

  it("finds bytes that do not decode", async () => {
    await writeFile(image, "not an image");
    sha256 = createHash("sha256").update("not an image").digest("hex");
    await sidecar("raw.png", {});
    expect(done(await img.verify({ in: image })).findings.map((f) => f.code)).toEqual(["image.undecodable"]);
  });

  it("finds a truncated image whose header is intact", async () => {
    const whole = await readFile(image);
    const cut = whole.subarray(0, Math.floor(whole.length / 2));
    await writeFile(image, cut);
    sha256 = createHash("sha256").update(cut).digest("hex");
    await sidecar("raw.png", {});
    expect(done(await img.verify({ in: image })).findings.map((f) => f.code)).toEqual(["image.undecodable"]);
  });

  it("fails only when the image itself cannot be read, and refuses a relative path", async () => {
    await expect(img.verify({ in: path.join(tmp, "missing.png") })).rejects.toMatchObject({ code: "fs.notFound" });
    await expect(img.verify({ in: "raw.png" })).rejects.toMatchObject({ code: "args.invalid" });
  });
});
