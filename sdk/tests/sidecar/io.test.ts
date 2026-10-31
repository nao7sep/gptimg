import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SIDECAR_FORMAT_VERSION } from "../../src/format-versions.ts";
import { readSidecar } from "../../src/sidecar/read.ts";
import { serializeSidecar, writeSidecar } from "../../src/sidecar/write.ts";
import type { GenerateSidecar } from "../../src/types.ts";

const WRITER = { name: "gptimgsdk" as const, version: "1.2.3" };
const header = (version: unknown = SIDECAR_FORMAT_VERSION, owner: unknown = "gptimg", kind: unknown = "sidecar") => ({ format: { owner, kind, version }, writer: WRITER });

function generateRecord(overrides: Partial<GenerateSidecar> = {}): GenerateSidecar {
  return {
    operation: "generate",
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

  it("writes the current format with a fixed key order and trailing newline, and reads it back as the typed record", async () => {
    const record = generateRecord();
    await writeSidecar(sidecarPath, record, WRITER, { overwrite: false });
    const text = await readFile(sidecarPath, "utf-8");
    expect(text).toBe(serializeSidecar(record, WRITER));
    expect(text.endsWith("\n")).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual(["format", "writer", "operation", "request", "response", "files"]);
    expect(JSON.parse(text).format).toEqual({ owner: "gptimg", kind: "sidecar", version: SIDECAR_FORMAT_VERSION });
    expect(JSON.parse(text).writer).toEqual(WRITER);
    await expect(readSidecar(sidecarPath)).resolves.toEqual(record);
  });

  it("refuses a sidecar without a header, or of another owner or kind, as malformed and leaves it unchanged", async () => {
    const content = { operation: "generate", request: { prompt: "p", n: 1 }, response: {}, files: [{ index: 1, name: "a.png", sha256: "ab", format: "png" }] };
    for (const old of [
      content,
      { formatVersion: 1, kind: "generate", writer: WRITER, ...content },
      { ...header(1, "fotoready"), ...content },
      { ...header(1, "gptimg", "chat"), ...content },
      { format: "gptimg.sidecar", writer: WRITER, ...content },
      { format: { owner: "gptimg", kind: "sidecar" }, writer: WRITER, ...content },
    ]) {
      const text = JSON.stringify(old);
      await writeFile(sidecarPath, text);
      await expect(readSidecar(sidecarPath)).rejects.toMatchObject({ code: "sidecar.malformed", subject: sidecarPath });
      expect(await readFile(sidecarPath, "utf-8")).toBe(text);
    }
  });

  it("treats a format version that is not a positive integer as malformed", async () => {
    for (const version of [0, 1.5, null, "1"]) {
      await writeFile(sidecarPath, JSON.stringify({ ...header(version), operation: "generate", request: { prompt: "p", n: 1 }, response: {}, files: [{ index: 1, name: "a.png", sha256: "ab", format: "png" }] }));
      await expect(readSidecar(sidecarPath)).rejects.toMatchObject({ code: "sidecar.malformed", subject: sidecarPath });
    }
  });

  it("refuses a sidecar of a newer format and leaves it byte-identical", async () => {
    const newer = JSON.stringify({ ...header(SIDECAR_FORMAT_VERSION + 1), future: true });
    await writeFile(sidecarPath, newer);
    await expect(readSidecar(sidecarPath)).rejects.toMatchObject({
      code: "sidecar.newerFormat",
      details: { expected: SIDECAR_FORMAT_VERSION, actual: SIDECAR_FORMAT_VERSION + 1 },
    });
    expect(await readFile(sidecarPath, "utf-8")).toBe(newer);
  });

  it("refuses to overwrite a sidecar of a newer format and leaves it byte-identical", async () => {
    const newer = JSON.stringify({ ...header(SIDECAR_FORMAT_VERSION + 1), future: true });
    await writeFile(sidecarPath, newer);
    await expect(writeSidecar(sidecarPath, generateRecord(), WRITER, { overwrite: true })).rejects.toMatchObject({
      code: "sidecar.newerFormat",
    });
    expect(await readFile(sidecarPath, "utf-8")).toBe(newer);
  });

  it("refuses with output.exists and preserves an existing sidecar when overwrite is false", async () => {
    await writeFile(sidecarPath, "existing");
    await expect(writeSidecar(sidecarPath, generateRecord(), WRITER, { overwrite: false })).rejects.toMatchObject({
      code: "output.exists",
      refusal: { subject: sidecarPath },
    });
    expect(await readFile(sidecarPath, "utf-8")).toBe("existing");
  });

  it("reports a sidecar of the wrong shape with its path and leaves it untouched", async () => {
    const wrong = JSON.stringify({ ...header(), operation: "edit", request: { prompt: "x", n: 1 }, response: {}, files: [] });
    await writeFile(sidecarPath, wrong);
    await expect(readSidecar(sidecarPath)).rejects.toMatchObject({ code: "sidecar.malformed", subject: sidecarPath });
    expect(await readFile(sidecarPath, "utf-8")).toBe(wrong);
  });

  it("never reads the writer: any value there is accepted and left out of the record", async () => {
    for (const writer of [undefined, null, "anything", { name: "someone else", version: 7 }]) {
      const { writer: _w, ...rest } = JSON.parse(serializeSidecar(generateRecord(), WRITER)) as Record<string, unknown>;
      await writeFile(sidecarPath, JSON.stringify(writer === undefined ? rest : { ...rest, writer }));
      await expect(readSidecar(sidecarPath)).resolves.toEqual(generateRecord());
    }
  });

  it("keeps keys it does not know when reading", async () => {
    const record = { ...generateRecord(), extra: { kept: true } };
    await writeFile(sidecarPath, serializeSidecar(record, WRITER).replace(/\n}\n$/, `,\n  "extra": {"kept": true}\n}\n`));
    await expect(readSidecar(sidecarPath)).resolves.toMatchObject({ extra: { kept: true } });
  });

  it("refuses to write a record of the wrong shape and writes nothing", async () => {
    await expect(
      writeSidecar(sidecarPath, generateRecord({ files: [] }), WRITER, { overwrite: false }),
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
