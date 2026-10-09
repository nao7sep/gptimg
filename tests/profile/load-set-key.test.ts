import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProfileError } from "../../src/errors.js";
import { PROFILE_FORMAT_VERSION } from "../../src/format-versions.js";
import { loadProfile } from "../../src/profile/load.js";
import { deobfuscate } from "../../src/profile/obfuscate.js";
import { clearApiKey, setApiKey } from "../../src/profile/setApiKey.js";

const POSIX = process.platform !== "win32";
const describePosix = POSIX ? describe : describe.skip;

describe("loadProfile", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-profile-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("loads a valid profile from disk", async () => {
    const file = path.join(tmp, "profile.json");
    await writeFile(
      file,
      JSON.stringify({
        formatVersion: 1,
        provider: "openai",
        organization: "org-local",
        project: "proj-local",
      }) + "\n",
    );

    await expect(loadProfile(file)).resolves.toEqual({
      provider: "openai",
      organization: "org-local",
      project: "proj-local",
    });
  });

  it("rejects invalid JSON-object shapes", async () => {
    const cases: [string, string][] = [
      ["array", "[]"],
      ["null", "null"],
    ];
    for (const [name, text] of cases) {
      const file = path.join(tmp, `${name}.json`);
      await writeFile(file, text);
      await expect(loadProfile(file), name).rejects.toMatchObject({
        code: "profile.invalidJson",
      });
    }
  });

  it("rejects malformed, unknown, and legacy profile fields", async () => {
    const cases: [string, Record<string, unknown>][] = [
      ["missing-provider", {}],
      ["empty-provider", { provider: "" }],
      ["unknown-field", { provider: "openai", model: "gpt-image-2" }],
      ["legacy-network-field", { provider: "openai", network: { imageGenerate: { timeout: 1000 } } }],
      ["legacy-timeout", { provider: "openai", timeout: 1234 }],
      ["legacy-max-retries", { provider: "openai", maxRetries: 4 }],
    ];
    for (const [name, value] of cases) {
      const file = path.join(tmp, `${name}.json`);
      await writeFile(file, JSON.stringify({ formatVersion: 1, ...value }));
      await expect(loadProfile(file), name).rejects.toMatchObject({
        code: "profile.validationFailed",
      });
    }
  });

  it("reports missing profiles as profile.notFound, saying how to provide a key", async () => {
    const missing = loadProfile(path.join(tmp, "missing.json"));
    await expect(missing).rejects.toMatchObject({ code: "profile.notFound" });
    await expect(missing).rejects.toThrow(/setApiKey\(\).*"apiKeyEnv"/);
  });
});

describePosix("loadProfile insecure-mode halt (POSIX)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-profile-mode-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("rejects loading a profile that holds apiKey when mode is group/world-readable", async () => {
    const file = path.join(tmp, "loose.json");
    await writeFile(
      file,
      JSON.stringify({ formatVersion: 1, provider: "openai", apiKey: "sk-loose" }) + "\n",
    );
    await chmod(file, 0o644);

    await expect(loadProfile(file)).rejects.toMatchObject({
      code: "profile.insecureMode",
      errorType: "profile",
    });
  });

  it("accepts apiKey-bearing profiles at mode 0o600", async () => {
    const file = path.join(tmp, "tight.json");
    await writeFile(
      file,
      JSON.stringify({ formatVersion: 1, provider: "openai", apiKey: "sk-tight" }) + "\n",
    );
    await chmod(file, 0o600);

    await expect(loadProfile(file)).resolves.toMatchObject({
      provider: "openai",
      apiKey: "sk-tight",
    });
  });

  it("does not check mode when apiKey is absent (apiKeyEnv-only profiles)", async () => {
    const file = path.join(tmp, "env-only.json");
    await writeFile(
      file,
      JSON.stringify({ formatVersion: 1, provider: "openai", apiKeyEnv: "OPENAI_API_KEY" }) + "\n",
    );
    await chmod(file, 0o644);

    await expect(loadProfile(file)).resolves.toMatchObject({
      provider: "openai",
      apiKeyEnv: "OPENAI_API_KEY",
    });
  });
});

describe("setApiKey / clearApiKey", () => {
  let tmp: string;
  let file: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-set-key-"));
    file = path.join(tmp, "nested", "profile.json");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("rejects an empty or whitespace-only key (the SDK owns this bound)", async () => {
    for (const key of ["", "   ", "\n\t"]) {
      await expect(setApiKey(file, key), JSON.stringify(key)).rejects.toMatchObject({
        code: "apiKey.missing",
        errorType: "profile",
      });
    }
    // A rejected key must not create or touch the profile file.
    await expect(loadProfile(file)).rejects.toMatchObject({ code: "profile.notFound" });
  });

  it("creates a default OpenAI profile when none exists", async () => {
    await setApiKey(file, "sk-local-created");

    const profile = await loadProfile(file);
    expect(profile.provider).toBe("openai");
    expect(typeof profile.apiKey).toBe("string");
    expect((profile.apiKey as string).startsWith("obf:")).toBe(true);
    expect(deobfuscate(profile.apiKey as string)).toBe("sk-local-created");
  });

  it("trims surrounding whitespace before storing the key", async () => {
    await setApiKey(file, "  sk-padded  ");

    const profile = await loadProfile(file);
    expect(deobfuscate(profile.apiKey as string)).toBe("sk-padded");
  });

  it("preserves unrelated fields and stores only an obfuscated key", async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        formatVersion: 1,
        provider: "openai",
        apiKeyEnv: "GPTIMG_TEST_KEY",
        organization: "org-local",
        project: "proj-local",
      }) + "\n",
    );

    await setApiKey(file, "sk-local-secret");

    const text = await readFile(file, "utf-8");
    expect(text).not.toContain("sk-local-secret");
    const profile = JSON.parse(text) as {
      provider: string;
      apiKey: string;
      apiKeyEnv: string;
      organization: string;
      project: string;
    };
    expect(profile).toMatchObject({
      provider: "openai",
      apiKeyEnv: "GPTIMG_TEST_KEY",
      organization: "org-local",
      project: "proj-local",
    });
    expect(deobfuscate(profile.apiKey)).toBe("sk-local-secret");
  });

  it("leaves the file untouched when the same key is saved again", async () => {
    await setApiKey(file, "sk-unchanged");
    const before = await stat(file);
    const textBefore = await readFile(file, "utf-8");

    // Padding is trimmed, so this is the same stored value.
    await setApiKey(file, "  sk-unchanged\n");

    const after = await stat(file);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(file, "utf-8")).toBe(textBefore);
  });

  it("rewrites a matching plaintext key into its obfuscated form", async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ formatVersion: 1, provider: "openai", apiKey: "sk-plain" }) + "\n");

    await setApiKey(file, "sk-plain");

    const text = await readFile(file, "utf-8");
    expect(text).not.toContain("sk-plain");
    const profile = await loadProfile(file);
    expect(deobfuscate(profile.apiKey as string)).toBe("sk-plain");
  });

  it.skipIf(!POSIX)("tightens a loose mode without rewriting when the same key is saved again", async () => {
    await setApiKey(file, "sk-unchanged");
    await chmod(file, 0o644);
    const before = await stat(file);

    await setApiKey(file, "sk-unchanged");

    const after = await stat(file);
    expect(after.mode & 0o777).toBe(0o600);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("clearApiKey removes only apiKey and keeps apiKeyEnv", async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        formatVersion: 1,
        provider: "openai",
        apiKey: "sk-plain",
        apiKeyEnv: "GPTIMG_TEST_KEY",
      }) + "\n",
    );

    await clearApiKey(file);

    await expect(loadProfile(file)).resolves.toEqual({
      provider: "openai",
      apiKeyEnv: "GPTIMG_TEST_KEY",
    });
  });

  it("clearApiKey is a no-op when apiKey is already absent", async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        formatVersion: 1,
        provider: "openai",
        apiKeyEnv: "GPTIMG_TEST_KEY",
      }) + "\n",
    );

    await clearApiKey(file);

    await expect(loadProfile(file)).resolves.toEqual({
      provider: "openai",
      apiKeyEnv: "GPTIMG_TEST_KEY",
    });
  });

  it("clearApiKey is a no-op when the profile file is missing", async () => {
    await expect(clearApiKey(file)).resolves.toBeUndefined();
  });

  it("preserves read errors instead of treating them as no-ops", async () => {
    await expect(clearApiKey(tmp)).rejects.toBeInstanceOf(ProfileError);
    await expect(clearApiKey(tmp)).rejects.toMatchObject({
      code: "profile.readFailed",
    });
  });

  it.skipIf(!POSIX)("writes the profile with owner-only mode (0o600)", async () => {
    await setApiKey(file, "sk-mode-check");
    const st = await stat(file);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it.skipIf(!POSIX)("tightens mode to 0o600 when re-saving a previously loose profile", async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ formatVersion: 1, provider: "openai", apiKeyEnv: "OPENAI_API_KEY" }) + "\n",
    );
    await chmod(file, 0o644);

    await setApiKey(file, "sk-replacing");
    const st = await stat(file);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it.skipIf(!POSIX)("setApiKey replaces the key on a loose-mode profile that already carries apiKey", async () => {
    // The strict load path would refuse this profile. set-key is part of the
    // remediation, so it must accept the file, replace the key, and tighten
    // the mode in one step. This pins the contract that modify paths never
    // halt on insecureMode for the very file they are about to fix.
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ formatVersion: 1, provider: "openai", apiKey: "stale-key-on-disk" }) + "\n",
    );
    await chmod(file, 0o644);

    await expect(setApiKey(file, "sk-fresh")).resolves.toBeUndefined();

    const st = await stat(file);
    expect(st.mode & 0o777).toBe(0o600);
    const profile = await loadProfile(file);
    expect(typeof profile.apiKey).toBe("string");
    expect(deobfuscate(profile.apiKey as string)).toBe("sk-fresh");
  });

  it.skipIf(!POSIX)("clearApiKey removes the key on a loose-mode profile that carries apiKey", async () => {
    // Same remediation contract for clear-key: must succeed on the exact
    // file that the strict load would reject, and must end at 0o600 with no
    // apiKey field.
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        formatVersion: 1,
        provider: "openai",
        apiKey: "leaked-key",
        apiKeyEnv: "OPENAI_API_KEY",
      }) + "\n",
    );
    await chmod(file, 0o644);

    await expect(clearApiKey(file)).resolves.toBeUndefined();

    const st = await stat(file);
    expect(st.mode & 0o777).toBe(0o600);
    await expect(loadProfile(file)).resolves.toEqual({
      provider: "openai",
      apiKeyEnv: "OPENAI_API_KEY",
    });
  });
});

describe("profile format version", () => {
  let tmp: string;
  let file: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-profile-format-"));
    file = path.join(tmp, "profile.json");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("reads a v0.1.0 profile, which has no formatVersion, and marks it only when it is next saved", async () => {
    const text = JSON.stringify({ provider: "openai", apiKeyEnv: "KEY", organization: "org-1" }) + "\n";
    await writeFile(file, text);
    if (process.platform !== "win32") await chmod(file, 0o600);

    await expect(loadProfile(file)).resolves.toEqual({ provider: "openai", apiKeyEnv: "KEY", organization: "org-1" });
    expect(await readFile(file, "utf-8")).toBe(text);

    await setApiKey(file, "sk-new");
    const written = JSON.parse(await readFile(file, "utf-8")) as Record<string, unknown>;
    expect(written).toMatchObject({ formatVersion: PROFILE_FORMAT_VERSION, apiKeyEnv: "KEY", organization: "org-1" });
  });

  it("treats a profile whose formatVersion is not a positive integer as unreadable", async () => {
    const text = JSON.stringify({ formatVersion: "1", provider: "openai" }) + "\n";
    await writeFile(file, text);

    await expect(loadProfile(file)).rejects.toMatchObject({ code: "profile.validationFailed" });
    await expect(setApiKey(file, "sk-new")).rejects.toMatchObject({ code: "profile.validationFailed" });
    expect(await readFile(file, "utf-8")).toBe(text);
  });

  it("writes the current format version and reads it back", async () => {
    await setApiKey(file, "sk-format");

    const written = JSON.parse(await readFile(file, "utf-8")) as Record<string, unknown>;
    expect(written.formatVersion).toBe(PROFILE_FORMAT_VERSION);
    const profile = await loadProfile(file);
    expect(profile).not.toHaveProperty("formatVersion");
    expect(profile).toEqual({ provider: "openai", apiKey: written.apiKey });
  });

  it("refuses a profile of a newer format on every path and leaves it byte-identical", async () => {
    const text =
      JSON.stringify({ formatVersion: PROFILE_FORMAT_VERSION + 1, provider: "openai", vault: {} }) + "\n";
    await writeFile(file, text);
    const before = await stat(file);

    for (const [name, run] of [
      ["loadProfile", () => loadProfile(file)],
      ["setApiKey", () => setApiKey(file, "sk-new")],
      ["clearApiKey", () => clearApiKey(file)],
    ] as const) {
      const err = await run().catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(ProfileError);
      expect(err, name).toMatchObject({ code: "profile.newerFormat" });
      expect((err as Error).message, name).toContain(file);
    }

    const after = await stat(file);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.mode).toBe(before.mode);
    expect(await readFile(file, "utf-8")).toBe(text);
  });

  it("rejects a formatVersion that is not a positive integer", async () => {
    for (const value of [0, 1.5, "1", null]) {
      await writeFile(file, JSON.stringify({ formatVersion: value, provider: "openai" }));
      await expect(loadProfile(file), JSON.stringify(value)).rejects.toMatchObject({
        code: "profile.validationFailed",
      });
    }
  });
});
