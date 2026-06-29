import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileError } from "../../src/errors.js";
import { obfuscate } from "../../src/profile/obfuscate.js";
import { resolveProfile } from "../../src/profile/resolve.js";
import type { Profile } from "../../src/types.js";

describe("resolveProfile", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses raw apiKey from profile when only apiKey is set", () => {
    const p: Profile = { provider: "openai", apiKey: "sk-raw-1" };
    const r = resolveProfile(p);
    expect(r.apiKey).toBe("sk-raw-1");
    expect(r.apiKeySource).toBe("profile.apiKey");
  });

  it("decodes obfuscated apiKey from profile", () => {
    const p: Profile = { provider: "openai", apiKey: obfuscate("sk-obf-2") };
    const r = resolveProfile(p);
    expect(r.apiKey).toBe("sk-obf-2");
    expect(r.apiKeySource).toBe("profile.apiKey");
  });

  it("uses env value when apiKeyEnv is set and env var present", () => {
    vi.stubEnv("GPTIMG_TEST_KEY", "from-env");
    const p: Profile = { provider: "openai", apiKeyEnv: "GPTIMG_TEST_KEY" };
    const r = resolveProfile(p);
    expect(r.apiKey).toBe("from-env");
    expect(r.apiKeySource).toBe("env:GPTIMG_TEST_KEY");
  });

  it("env wins over profile.apiKey when both are present", () => {
    vi.stubEnv("GPTIMG_TEST_KEY", "from-env");
    const p: Profile = {
      provider: "openai",
      apiKey: obfuscate("from-profile"),
      apiKeyEnv: "GPTIMG_TEST_KEY",
    };
    const r = resolveProfile(p);
    expect(r.apiKey).toBe("from-env");
    expect(r.apiKeySource).toBe("env:GPTIMG_TEST_KEY");
  });

  it("falls through to apiKey when apiKeyEnv names an unset variable", () => {
    vi.stubEnv("GPTIMG_TEST_KEY", undefined);
    const p: Profile = {
      provider: "openai",
      apiKey: obfuscate("from-profile"),
      apiKeyEnv: "GPTIMG_TEST_KEY",
    };
    const r = resolveProfile(p);
    expect(r.apiKey).toBe("from-profile");
    expect(r.apiKeySource).toBe("profile.apiKey");
  });

  it("falls through to apiKey when apiKeyEnv names an empty variable", () => {
    vi.stubEnv("GPTIMG_TEST_KEY", "");
    const p: Profile = {
      provider: "openai",
      apiKey: "from-profile",
      apiKeyEnv: "GPTIMG_TEST_KEY",
    };
    const r = resolveProfile(p);
    expect(r.apiKey).toBe("from-profile");
  });

  it("throws apiKey.missing when neither is usable", () => {
    const p: Profile = { provider: "openai" };
    expect(() => resolveProfile(p)).toThrow(ProfileError);
    try {
      resolveProfile(p);
    } catch (err) {
      expect((err as ProfileError).code).toBe("apiKey.missing");
    }
  });

  it("trims surrounding whitespace from the env value", () => {
    vi.stubEnv("GPTIMG_TEST_KEY", "  from-env  ");
    const p: Profile = { provider: "openai", apiKeyEnv: "GPTIMG_TEST_KEY" };
    expect(resolveProfile(p).apiKey).toBe("from-env");
  });

  it("trims surrounding whitespace from a stored key", () => {
    const p: Profile = { provider: "openai", apiKey: obfuscate("  sk-pad  ") };
    expect(resolveProfile(p).apiKey).toBe("sk-pad");
  });

  it("treats a whitespace-only env value as unset and falls through to apiKey", () => {
    vi.stubEnv("GPTIMG_TEST_KEY", "   ");
    const p: Profile = {
      provider: "openai",
      apiKey: obfuscate("from-profile"),
      apiKeyEnv: "GPTIMG_TEST_KEY",
    };
    expect(resolveProfile(p).apiKey).toBe("from-profile");
  });

  it("excludes apiKey and apiKeyEnv from the redacted snapshot", () => {
    vi.stubEnv("GPTIMG_TEST_KEY", "from-env");
    const p: Profile = {
      provider: "openai",
      organization: "openai-org",
      apiKey: "secret",
      apiKeyEnv: "GPTIMG_TEST_KEY",
    };
    const r = resolveProfile(p);
    expect(r.redacted).not.toHaveProperty("apiKey");
    expect(r.redacted).not.toHaveProperty("apiKeyEnv");
    expect(r.redacted.provider).toBe("openai");
    expect(r.redacted.organization).toBe("openai-org");
  });
});
