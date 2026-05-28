import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProfileError } from "../../src/errors.js";
import { loadProfile } from "../../src/profile/load.js";
import { deobfuscate, isObfuscated } from "../../src/profile/obfuscate.js";
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
        provider: "openai",
        organization: "org-local",
        project: "proj-local",
        network: { imageGenerate: { timeout: 1000 } },
      }) + "\n",
    );

    await expect(loadProfile(file)).resolves.toEqual({
      provider: "openai",
      organization: "org-local",
      project: "proj-local",
      network: { imageGenerate: { timeout: 1000 } },
    });
  });

  it("rejects invalid JSON-object shapes", async () => {
    for (const [name, text] of [
      ["array", "[]"],
      ["null", "null"],
    ]) {
      const file = path.join(tmp, `${name}.json`);
      await writeFile(file, text);
      await expect(loadProfile(file), name).rejects.toMatchObject({
        code: "profile.invalidJson",
      });
    }
  });

  it("rejects malformed, unknown, and legacy profile fields", async () => {
    for (const [name, value] of [
      ["missing-provider", {}],
      ["empty-provider", { provider: "" }],
      ["unknown-field", { provider: "openai", model: "gpt-image-2" }],
      ["legacy-timeout", { provider: "openai", timeout: 1234 }],
      ["legacy-max-retries", { provider: "openai", maxRetries: 4 }],
      ["unknown-network-category", { provider: "openai", network: { typo: {} } }],
      [
        "unknown-network-field",
        { provider: "openai", network: { imageGenerate: { retryInterval: 1000 } } },
      ],
    ]) {
      const file = path.join(tmp, `${name}.json`);
      await writeFile(file, JSON.stringify(value));
      await expect(loadProfile(file), name).rejects.toMatchObject({
        code: "profile.validationFailed",
      });
    }
  });

  it("reports missing profiles as profile.notFound", async () => {
    await expect(loadProfile(path.join(tmp, "missing.json"))).rejects.toMatchObject({
      code: "profile.notFound",
    });
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
      JSON.stringify({ provider: "openai", apiKey: "sk-loose" }) + "\n",
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
      JSON.stringify({ provider: "openai", apiKey: "sk-tight" }) + "\n",
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
      JSON.stringify({ provider: "openai", apiKeyEnv: "OPENAI_API_KEY" }) + "\n",
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

  it("creates a default OpenAI profile when none exists", async () => {
    await setApiKey(file, "sk-local-created");

    const profile = await loadProfile(file);
    expect(profile.provider).toBe("openai");
    expect(typeof profile.apiKey).toBe("string");
    expect(isObfuscated(profile.apiKey as string)).toBe(true);
    expect(deobfuscate(profile.apiKey as string)).toBe("sk-local-created");
  });

  it("preserves unrelated fields and stores only an obfuscated key", async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        provider: "openai",
        apiKeyEnv: "GPTIMG_TEST_KEY",
        organization: "org-local",
        project: "proj-local",
        network: { imageGenerate: { timeout: 1000 } },
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
      network: unknown;
    };
    expect(profile).toMatchObject({
      provider: "openai",
      apiKeyEnv: "GPTIMG_TEST_KEY",
      organization: "org-local",
      project: "proj-local",
      network: { imageGenerate: { timeout: 1000 } },
    });
    expect(deobfuscate(profile.apiKey)).toBe("sk-local-secret");
  });

  it("clearApiKey removes only apiKey and keeps apiKeyEnv", async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
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
      JSON.stringify({ provider: "openai", apiKeyEnv: "OPENAI_API_KEY" }) + "\n",
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
      JSON.stringify({ provider: "openai", apiKey: "stale-key-on-disk" }) + "\n",
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
