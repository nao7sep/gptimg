import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProfileError } from "../../src/errors.js";
import { loadProfile } from "../../src/profile/load.js";
import { deobfuscate, isObfuscated } from "../../src/profile/obfuscate.js";
import { clearApiKey, setApiKey } from "../../src/profile/setApiKey.js";

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
});
