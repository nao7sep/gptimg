import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSidecar } from "../../src/sidecar/read.js";
import { writeSidecar } from "../../src/sidecar/write.js";
import type { Sidecar } from "../../src/types.js";

describe("sidecar read/write", () => {
  let tmp: string;
  let stem: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-sidecar-"));
    stem = path.join(tmp, "result");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("writes redacted JSON with a trailing newline and reads it back", async () => {
    const sidecar: Sidecar = {
      request: { prompt: "x", apiKey: "secret" },
      response: { ok: true },
      files: [{ index: 1, name: "out.png", sha256: "abc", format: "png" }],
    };

    const file = await writeSidecar(stem, sidecar);

    const text = await readFile(file, "utf-8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toContain("secret");
    expect(JSON.parse(text)).toEqual({
      request: { prompt: "x", apiKey: "[redacted]" },
      response: { ok: true },
      files: [{ index: 1, name: "out.png", sha256: "abc", format: "png" }],
    });
    await expect(readSidecar(stem)).resolves.toEqual(JSON.parse(text));
  });

  it("reports invalid sidecar JSON as a local image decode failure", async () => {
    await writeFile(`${stem}.json`, "{bad json");

    await expect(readSidecar(stem)).rejects.toMatchObject({
      errorType: "localOp",
      code: "image.decodeFailed",
    });
  });

  it("reports missing sidecars as local image decode failures", async () => {
    await expect(readSidecar(path.join(tmp, "missing"))).rejects.toMatchObject({
      errorType: "localOp",
      code: "image.decodeFailed",
    });
  });
});
