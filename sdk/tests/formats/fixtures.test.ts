// Every supported persisted format, pinned by a fixture (sdk-conventions,
// *Persisted formats are pinned by fixtures*): the current code reads each to
// its typed value, refuses the newer-format samples without touching them, and
// the current writer reproduces the format-2 sidecars byte for byte. A change
// to how old output is read or new output is written fails here first.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSidecar } from "../../src/sidecar/read.ts";
import { serializeSidecar } from "../../src/sidecar/write.ts";

const FORMATS = fileURLToPath(new URL("../fixtures/formats/", import.meta.url));
const fixture = (name: string): string => path.join(FORMATS, name);

describe("sidecar fixtures", () => {
  it("reads the real unmarked v0.1.0 sidecar from company/assets as a format-1 generate record", async () => {
    const record = await readSidecar(fixture("sidecar-v0.1.0-generate.json"));
    expect(record).toMatchObject({
      formatVersion: 1,
      kind: "generate",
      writer: null,
      request: { n: 1, chroma: { color: "#00ff00" }, prompt: expect.stringContaining("star") },
      files: [{ index: 1, name: "star-original.png", format: "png", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }],
    });
  });

  it.each([
    ["sidecar-v1-generate.json", "generate"],
    ["sidecar-v1-edit.json", "edit"],
    ["sidecar-v1-vision.json", "vision"],
  ] as const)("reads %s as a format-1 %s record with no writer", async (name, kind) => {
    const record = await readSidecar(fixture(name));
    expect(record).toMatchObject({ formatVersion: 1, kind, writer: null });
  });

  it.each([
    ["sidecar-v2-generate.json", "generate"],
    ["sidecar-v2-edit.json", "edit"],
    ["sidecar-v2-vision.json", "vision"],
  ] as const)("reads %s as a format-2 %s record and the writer reproduces it byte for byte", async (name, kind) => {
    const bytes = await readFile(fixture(name), "utf8");
    const record = await readSidecar(fixture(name));
    expect(record).toMatchObject({
      formatVersion: 2,
      kind,
      writer: { name: "gptimgsdk", version: "0.1.0", app: { name: "GptImg", version: "0.1.0" } },
    });
    expect(serializeSidecar(record)).toBe(bytes);
  });

  it("refuses the newer-format sample without changing it", async () => {
    const before = await readFile(fixture("sidecar-newer.json"), "utf8");
    await expect(readSidecar(fixture("sidecar-newer.json"))).rejects.toMatchObject({ code: "sidecar.newerFormat" });
    expect(await readFile(fixture("sidecar-newer.json"), "utf8")).toBe(before);
  });
});
