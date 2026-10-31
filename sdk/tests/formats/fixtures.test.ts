// Every supported persisted format, pinned by a fixture (sdk-conventions,
// *Persisted formats are pinned by fixtures*): the current code reads each to
// its typed value, refuses the newer-format sample without touching it, and
// the current writer reproduces the sidecars byte for byte. A change
// to how output is read or written fails here first.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSidecar } from "../../src/sidecar/read.ts";
import { serializeSidecar } from "../../src/sidecar/write.ts";

const FORMATS = fileURLToPath(new URL("../fixtures/formats/", import.meta.url));
const fixture = (name: string): string => path.join(FORMATS, name);

describe("sidecar fixtures", () => {
  it.each([
    ["sidecar-generate.json", "generate"],
    ["sidecar-edit.json", "edit"],
    ["sidecar-vision.json", "vision"],
    ["sidecar-chat.json", "chat"],
  ] as const)("reads %s as a %s record and the writer reproduces it byte for byte", async (name, kind) => {
    const bytes = await readFile(fixture(name), "utf8");
    const record = await readSidecar(fixture(name));
    expect(record).toMatchObject({
      formatVersion: 1,
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
