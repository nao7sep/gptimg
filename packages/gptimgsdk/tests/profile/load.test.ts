import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProfile, validateProfile } from "../../src/profile/load.ts";

const POSIX = process.platform !== "win32";

function obf(raw: string): string {
  return "obf:" + Buffer.from(raw, "utf-8").reverse().toString("base64");
}

describe("loadProfile", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-profile-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function write(name: string, body: unknown, mode = 0o600): Promise<string> {
    const file = path.join(tmp, name);
    await writeFile(file, JSON.stringify(body) + "\n");
    if (POSIX) await chmod(file, mode);
    return file;
  }

  it("reads an unmarked v0.1.0 profile and a marked format-1 profile unchanged", async () => {
    for (const formatVersion of [undefined, 1]) {
      const file = await write(`v1-${formatVersion}.json`, {
        ...(formatVersion !== undefined && { formatVersion }),
        provider: "openai",
        organization: "org-local",
        project: "proj-local",
      });
      const before = await readFile(file, "utf8");
      await expect(loadProfile(file)).resolves.toEqual({
        path: file,
        provider: "openai",
        apiKey: null,
        apiKeySource: null,
        organization: "org-local",
        project: "proj-local",
      });
      expect(await readFile(file, "utf8")).toBe(before);
    }
  });

  it("resolves the key from the variable apiKeyEnv names in the passed map, before the stored key", async () => {
    const file = await write("both.json", { formatVersion: 2, provider: "openai", apiKey: obf("sk-stored"), apiKeyEnv: "MY_KEY" });
    await expect(loadProfile(file, { env: { MY_KEY: "  sk-env  " } })).resolves.toMatchObject({
      apiKey: "sk-env",
      apiKeySource: "env:MY_KEY",
    });
    await expect(loadProfile(file, { env: { MY_KEY: "   " } })).resolves.toMatchObject({
      apiKey: "sk-stored",
      apiKeySource: "profile.apiKey",
    });
  });

  it("never reads the process environment, even for the variable the profile names", async () => {
    const file = await write("env-only.json", { provider: "openai", apiKeyEnv: "GPTIMG_TEST_AMBIENT_KEY" });
    process.env.GPTIMG_TEST_AMBIENT_KEY = "sk-ambient";
    try {
      await expect(loadProfile(file)).resolves.toMatchObject({ apiKey: null, apiKeySource: null });
    } finally {
      delete process.env.GPTIMG_TEST_AMBIENT_KEY;
    }
  });

  it("makes format-2 paths absolute: ~ and $VAR from the passed map, relative ones against the profile's folder", async () => {
    const file = await write("paths.json", {
      formatVersion: 2,
      provider: "openai",
      modelsDir: "~/models",
      logDir: "logs/$RUN",
      policy: { generate: { quality: "low" } },
    });
    const home = path.join(tmp, "home");
    const loaded = await loadProfile(file, { env: { HOME: home, USERPROFILE: home, RUN: "r1" } });
    expect(loaded.modelsDir).toBe(path.join(home, "models"));
    expect(loaded.logDir).toBe(path.join(tmp, "logs", "r1"));
    expect(loaded.policy).toEqual({ generate: { quality: "low" } });
  });

  it("refuses a path reference the passed map cannot satisfy, naming the variable", async () => {
    const file = await write("unset.json", { formatVersion: 2, provider: "openai", modelsDir: "$NOWHERE/models" });
    await expect(loadProfile(file, { env: {} })).rejects.toMatchObject({
      code: "profile.malformed",
      kind: "invalid",
      details: { field: "modelsDir", variable: "NOWHERE" },
    });
  });

  it("refuses a relative profile path, an unknown field and a newer format, leaving the file unchanged", async () => {
    await expect(loadProfile("profile.json")).rejects.toMatchObject({ code: "args.invalid", details: { field: "profile path" } });
    const typo = await write("typo.json", { provider: "openai", apiKeyENV: "X" });
    await expect(loadProfile(typo)).rejects.toMatchObject({ code: "profile.malformed", subject: typo });
    const newer = await write("newer.json", { formatVersion: 3, provider: "openai" });
    const before = await readFile(newer, "utf8");
    await expect(loadProfile(newer)).rejects.toMatchObject({ code: "profile.newerFormat", details: { expected: 2, actual: 3 } });
    expect(await readFile(newer, "utf8")).toBe(before);
  });

  it("reports a missing profile by the filesystem's cause", async () => {
    const missing = path.join(tmp, "missing.json");
    await expect(loadProfile(missing)).rejects.toMatchObject({ code: "fs.notFound", kind: "unavailable", subject: missing });
  });

  it("refuses invalid JSON and a malformed obf: key", async () => {
    const bad = path.join(tmp, "bad.json");
    await writeFile(bad, "{ not json");
    await expect(loadProfile(bad)).rejects.toMatchObject({ code: "profile.malformed" });
    const obfBad = await write("obf.json", { provider: "openai", apiKey: "obf:%%%" });
    await expect(loadProfile(obfBad)).rejects.toMatchObject({ code: "apiKey.malformed" });
  });

  it.skipIf(!POSIX)("refuses a key-bearing profile readable beyond its owner, never tightening it", async () => {
    const loose = await write("loose.json", { provider: "openai", apiKey: "sk-loose" }, 0o644);
    await expect(loadProfile(loose)).rejects.toMatchObject({ code: "profile.insecureMode", details: { mode: "644" } });
    const { stat } = await import("node:fs/promises");
    expect((await stat(loose)).mode & 0o777).toBe(0o644);
  });

  it.skipIf(!POSIX)("checks a symlinked profile's target mode", async () => {
    const target = await write("target.json", { provider: "openai", apiKey: "sk-target" }, 0o644);
    const link = path.join(tmp, "link.json");
    await symlink(target, link);
    await expect(loadProfile(link)).rejects.toMatchObject({ code: "profile.insecureMode" });
  });

  it.skipIf(!POSIX)("accepts a loose profile that stores no key", async () => {
    const file = await write("nokey.json", { provider: "openai", apiKeyEnv: "OPENAI_API_KEY" }, 0o644);
    await expect(loadProfile(file, { env: { OPENAI_API_KEY: "sk-x" } })).resolves.toMatchObject({ apiKey: "sk-x" });
  });
});

describe("validateProfile", () => {
  it("accepts format 1 and 2 bodies and refuses a provider other than openai", () => {
    expect(validateProfile({ provider: "openai" })).toEqual({ provider: "openai" });
    expect(validateProfile({ formatVersion: 2, provider: "openai", modelsDir: "/m" })).toEqual({ provider: "openai", modelsDir: "/m" });
    expect(() => validateProfile({ provider: "other" })).toThrow(/provider/);
  });
});
