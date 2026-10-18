// Every supported persisted format, pinned by a fixture (sdk-conventions,
// *Persisted formats are pinned by fixtures*): the current code reads each to
// its typed value, refuses the newer-format samples without touching them, and
// the current writer reproduces the format-2 sidecars byte for byte. A change
// to how old output is read or new output is written fails here first.
import { chmod, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProfile } from "../../src/profile/load.ts";
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

describe("profile fixtures", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-format-fixtures-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  /** The fixture copied owner-only, as a profile that stores a key must be. */
  async function copy(name: string): Promise<string> {
    const target = path.join(tmp, name);
    await copyFile(fixture(name), target);
    if (process.platform !== "win32") await chmod(target, 0o600);
    return target;
  }

  it("reads an unmarked v0.1.0 profile with a stored obf: key", async () => {
    const file = await copy("profile-v0.1.0-key.json");
    await expect(loadProfile(file)).resolves.toEqual({
      path: file,
      provider: "openai",
      apiKey: "sk-fixture-stored",
      apiKeySource: "profile.apiKey",
    });
  });

  it("reads a format-1 profile that names its key's variable", async () => {
    const file = await copy("profile-v1-env.json");
    await expect(loadProfile(file, { env: { OPENAI_API_KEY: "sk-from-env" } })).resolves.toEqual({
      path: file,
      provider: "openai",
      apiKey: "sk-from-env",
      apiKeySource: "env:OPENAI_API_KEY",
      organization: "org-fixture",
    });
  });

  it("reads a format-2 profile with its folders and policy", async () => {
    const file = await copy("profile-v2.json");
    const home = path.join(tmp, "home");
    await expect(loadProfile(file, { env: { HOME: home, USERPROFILE: home } })).resolves.toEqual({
      path: file,
      provider: "openai",
      apiKey: null,
      apiKeySource: null,
      modelsDir: path.join(home, "models"),
      logDir: path.join(tmp, "logs"),
      policy: { generate: { quality: "low" }, onnx: { intraOpThreads: 2 } },
    });
  });

  it("refuses the newer-format profile without changing it", async () => {
    const file = await copy("profile-newer.json");
    const before = await readFile(file, "utf8");
    await expect(loadProfile(file)).rejects.toMatchObject({ code: "profile.newerFormat" });
    expect(await readFile(file, "utf8")).toBe(before);
  });
});
