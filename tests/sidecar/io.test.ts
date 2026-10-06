import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalOpError } from "../../src/errors.js";
import { SIDECAR_FORMAT_VERSION } from "../../src/format-versions.js";
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

  it("writes the sidecar as given with its format version, as JSON with a trailing newline, and reads it back", async () => {
    const sidecar: Sidecar = {
      request: { prompt: "x", apiKey: "secret" },
      response: { ok: true },
      files: [{ index: 1, name: "out.png", sha256: "abc", format: "png" }],
    };

    const file = await writeSidecar(stem, sidecar);

    const text = await readFile(file, "utf-8");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({ formatVersion: SIDECAR_FORMAT_VERSION, ...sidecar });
    await expect(readSidecar(stem)).resolves.toEqual(sidecar);
  });

  it("treats a sidecar with no formatVersion as unreadable", async () => {
    await writeFile(`${stem}.json`, JSON.stringify({ request: { prompt: "old" }, response: {}, files: [] }));

    await expect(readSidecar(stem)).rejects.toMatchObject({
      errorType: "localOp",
      code: "image.decodeFailed",
    });
  });

  it("refuses a sidecar of a newer format and leaves it byte-identical", async () => {
    const file = `${stem}.json`;
    const text = JSON.stringify({ formatVersion: SIDECAR_FORMAT_VERSION + 1, request: {}, files: "new" });
    await writeFile(file, text);

    const err = await readSidecar(stem).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalOpError);
    expect(err).toMatchObject({ code: "sidecar.newerFormat" });
    expect((err as Error).message).toContain(file);
    expect(await readFile(file, "utf-8")).toBe(text);
  });

  it("refuses to overwrite a sidecar of a newer format and leaves it byte-identical", async () => {
    const file = `${stem}.json`;
    const text = JSON.stringify({ formatVersion: SIDECAR_FORMAT_VERSION + 1, request: {}, files: "new" });
    await writeFile(file, text);

    await expect(writeSidecar(stem, { request: {}, response: {}, files: [] })).rejects.toMatchObject({
      code: "sidecar.newerFormat",
    });
    expect(await readFile(file, "utf-8")).toBe(text);
  });

  it("preserves an existing sidecar when overwrite is false", async () => {
    const first: Sidecar = { request: { prompt: "winner" }, response: {}, files: [] };
    const second: Sidecar = { request: { prompt: "loser" }, response: {}, files: [] };
    await writeSidecar(stem, first);

    await expect(writeSidecar(stem, second, { overwrite: false })).rejects.toMatchObject({
      code: "output.exists",
    });
    await expect(readSidecar(stem)).resolves.toMatchObject({ request: { prompt: "winner" } });
  });

  it("reports a current sidecar of the wrong shape with its path and leaves it untouched", async () => {
    const file = `${stem}.json`;
    const valid = { request: { chroma: { color: "#00ff00" } }, response: {}, files: [] };
    const { files: _files, ...noFiles } = valid;
    const { response: _response, ...noResponse } = valid;
    for (const body of [noFiles, noResponse, { ...valid, request: "x" }, { ...valid, files: [{ index: 1, name: "a.png" }] }]) {
      const text = JSON.stringify({ formatVersion: SIDECAR_FORMAT_VERSION, ...body });
      await writeFile(file, text);

      const err = await readSidecar(stem).catch((e: unknown) => e);
      expect(err).toMatchObject({ errorType: "localOp", code: "sidecar.malformed" });
      expect((err as Error).message).toContain(file);
      expect(await readFile(file, "utf-8")).toBe(text);
    }
  });

  it("keeps keys it does not know when reading a current sidecar", async () => {
    await writeFile(
      `${stem}.json`,
      JSON.stringify({ formatVersion: SIDECAR_FORMAT_VERSION, request: {}, response: null, files: [], note: "kept" }),
    );
    await expect(readSidecar(stem)).resolves.toEqual({ request: {}, response: null, files: [], note: "kept" });
  });

  it("refuses to write a sidecar of the wrong shape and writes nothing", async () => {
    const bad = { request: {}, response: {} } as unknown as Sidecar;
    await expect(writeSidecar(stem, bad)).rejects.toMatchObject({ code: "sidecar.malformed" });
    expect(await readdir(tmp)).toEqual([]);
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
