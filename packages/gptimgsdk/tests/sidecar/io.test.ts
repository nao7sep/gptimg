import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SIDECAR_FORMAT_VERSION } from "../../src/format-versions.ts";
import { readSidecar } from "../../src/sidecar/read.ts";
import { serializeSidecar, writeSidecar } from "../../src/sidecar/write.ts";
import type { GenerateSidecar } from "../../src/types.ts";

const WRITER = { name: "gptimgsdk" as const, version: "1.2.3" };

function generateRecord(overrides: Partial<GenerateSidecar> = {}): GenerateSidecar {
  return {
    formatVersion: 2,
    kind: "generate",
    writer: WRITER,
    request: { model: "gpt-image-2.5-flare", prompt: "a red disc", n: 1, chroma: { color: "#00ff00" } },
    response: { created: 1791931849, data: [{ b64_json: null }], usage: { total_tokens: 126 } },
    files: [{ index: 1, name: "out.png", sha256: "ab".repeat(32), format: "png" }],
    ...overrides,
  };
}

describe("sidecar read/write", () => {
  let tmp: string;
  let sidecarPath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-sidecar-"));
    sidecarPath = path.join(tmp, "out.json");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("writes format 2 with a fixed key order and trailing newline, and reads it back as the typed record", async () => {
    const record = generateRecord();
    await writeSidecar(sidecarPath, record, { overwrite: false });
    const text = await readFile(sidecarPath, "utf-8");
    expect(text).toBe(serializeSidecar(record));
    expect(text.endsWith("\n")).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual(["formatVersion", "kind", "writer", "request", "response", "files"]);
    expect(JSON.parse(text).formatVersion).toBe(SIDECAR_FORMAT_VERSION);
    await expect(readSidecar(sidecarPath)).resolves.toEqual(record);
  });

  it("reads an unmarked v0.1.0 sidecar as format 1, telling its kind apart by shape, with no writer", async () => {
    const generate = { request: { prompt: "old", n: 1 }, response: {}, files: [{ index: 1, name: "a.png", sha256: "ab", format: "png" }] };
    await writeFile(sidecarPath, JSON.stringify(generate));
    await expect(readSidecar(sidecarPath)).resolves.toEqual({ formatVersion: 1, kind: "generate", writer: null, ...generate });

    const edit = { formatVersion: 1, request: { prompt: "e", n: 1, input: "a.png", mask: null }, response: {}, files: [] };
    await writeFile(sidecarPath, JSON.stringify(edit));
    await expect(readSidecar(sidecarPath)).resolves.toMatchObject({ formatVersion: 1, kind: "edit" });

    const vision = { formatVersion: 1, request: { check: "c", inputs: [] }, response: { verdict: { ok: true, score: 1, reasons: [] }, raw: {} }, files: [] };
    await writeFile(sidecarPath, JSON.stringify(vision));
    await expect(readSidecar(sidecarPath)).resolves.toMatchObject({ formatVersion: 1, kind: "vision" });
  });

  it("treats a formatVersion that is not a positive integer as malformed", async () => {
    for (const formatVersion of [1.5, null]) {
      await writeFile(sidecarPath, JSON.stringify({ formatVersion, request: {}, response: {}, files: [] }));
      await expect(readSidecar(sidecarPath)).rejects.toMatchObject({ code: "sidecar.malformed", subject: sidecarPath });
    }
  });

  it("refuses a sidecar of a newer format and leaves it byte-identical", async () => {
    const newer = JSON.stringify({ formatVersion: SIDECAR_FORMAT_VERSION + 1, future: true });
    await writeFile(sidecarPath, newer);
    await expect(readSidecar(sidecarPath)).rejects.toMatchObject({
      code: "sidecar.newerFormat",
      details: { expected: SIDECAR_FORMAT_VERSION, actual: SIDECAR_FORMAT_VERSION + 1 },
    });
    expect(await readFile(sidecarPath, "utf-8")).toBe(newer);
  });

  it("refuses to overwrite a sidecar of a newer format and leaves it byte-identical", async () => {
    const newer = JSON.stringify({ formatVersion: SIDECAR_FORMAT_VERSION + 1, future: true });
    await writeFile(sidecarPath, newer);
    await expect(writeSidecar(sidecarPath, generateRecord(), { overwrite: true })).rejects.toMatchObject({
      code: "sidecar.newerFormat",
    });
    expect(await readFile(sidecarPath, "utf-8")).toBe(newer);
  });

  it("refuses with output.exists and preserves an existing sidecar when overwrite is false", async () => {
    await writeFile(sidecarPath, "existing");
    await expect(writeSidecar(sidecarPath, generateRecord(), { overwrite: false })).rejects.toMatchObject({
      code: "output.exists",
      refusal: { subject: sidecarPath },
    });
    expect(await readFile(sidecarPath, "utf-8")).toBe("existing");
  });

  it("reports a format-2 sidecar of the wrong shape with its path and leaves it untouched", async () => {
    const wrong = JSON.stringify({ formatVersion: 2, kind: "edit", writer: WRITER, request: { prompt: "x", n: 1 }, response: {}, files: [] });
    await writeFile(sidecarPath, wrong);
    await expect(readSidecar(sidecarPath)).rejects.toMatchObject({ code: "sidecar.malformed", subject: sidecarPath });
    expect(await readFile(sidecarPath, "utf-8")).toBe(wrong);
  });

  it("keeps keys it does not know when reading", async () => {
    const record = { ...generateRecord(), extra: { kept: true } };
    await writeFile(sidecarPath, serializeSidecar(record).replace(/\n}\n$/, `,\n  "extra": {"kept": true}\n}\n`));
    await expect(readSidecar(sidecarPath)).resolves.toMatchObject({ extra: { kept: true } });
  });

  it("refuses to write a record of the wrong shape and writes nothing", async () => {
    await expect(
      writeSidecar(sidecarPath, generateRecord({ files: [] }), { overwrite: false }),
    ).rejects.toMatchObject({ code: "internal.invariant", kind: "internal" });
    expect(await readdir(tmp)).toEqual([]);
  });

  it("reports invalid JSON as malformed and a missing sidecar by the filesystem's cause", async () => {
    await writeFile(sidecarPath, "{ nope");
    await expect(readSidecar(sidecarPath)).rejects.toMatchObject({ code: "sidecar.malformed" });
    await expect(readSidecar(path.join(tmp, "missing.json"))).rejects.toMatchObject({ code: "fs.notFound" });
  });

  it("refuses a relative sidecar path", async () => {
    await expect(readSidecar("out.json")).rejects.toMatchObject({ code: "args.invalid" });
  });
});
