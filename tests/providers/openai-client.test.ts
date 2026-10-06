import { describe, expect, it, vi } from "vitest";
import { getProvider } from "../../src/providers/index.js";
import { buildOpenAIClient, clientHeaders, resolveModel } from "../../src/providers/openai/client.js";
import type { ResolvedProfile } from "../../src/types.js";

describe("OpenAI client helpers", () => {
  it("constructs the SDK client from the resolved profile without SDK retries", () => {
    const profile: ResolvedProfile = {
      apiKey: "sk-local",
      apiKeySource: "profile.apiKey",
      redacted: {
        provider: "openai",
        organization: "org-local",
        project: "proj-local",
      },
    };

    const client = buildOpenAIClient(profile);

    expect(client.apiKey).toBe("sk-local");
    expect(client.organization).toBe("org-local");
    expect(client.project).toBe("proj-local");
    expect(client.maxRetries).toBe(0);
  });

  it("records the identity headers the client sends, the SDK's environment defaults included", () => {
    vi.stubEnv("OPENAI_ORG_ID", "org-env");
    vi.stubEnv("OPENAI_PROJECT_ID", "proj-env");
    try {
      const fromEnv = buildOpenAIClient({ apiKey: "sk-local", apiKeySource: "profile.apiKey", redacted: { provider: "openai" } });
      expect(clientHeaders(fromEnv)).toEqual({
        Authorization: "Bearer sk-local",
        "OpenAI-Organization": "org-env",
        "OpenAI-Project": "proj-env",
      });
      const fromProfile = buildOpenAIClient({
        apiKey: "sk-local",
        apiKeySource: "profile.apiKey",
        redacted: { provider: "openai", organization: "org-local" },
      });
      expect(clientHeaders(fromProfile)).toEqual({
        Authorization: "Bearer sk-local",
        "OpenAI-Organization": "org-local",
        "OpenAI-Project": "proj-env",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("records no organization or project header when neither the profile nor the environment sets one", () => {
    vi.stubEnv("OPENAI_ORG_ID", undefined);
    vi.stubEnv("OPENAI_PROJECT_ID", undefined);
    try {
      const client = buildOpenAIClient({ apiKey: "sk-local", apiKeySource: "profile.apiKey", redacted: { provider: "openai" } });
      expect(clientHeaders(client)).toEqual({ Authorization: "Bearer sk-local" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("resolves model from params, falling back to the provider default", () => {
    expect(resolveModel("param-model", "fallback")).toBe("param-model");
    expect(resolveModel(undefined, "fallback")).toBe("fallback");
    expect(resolveModel("", "fallback")).toBe("fallback");
  });

  it("returns the OpenAI provider and rejects unknown providers", () => {
    expect(getProvider("openai").name).toBe("openai");
    expect(() => getProvider("nope")).toThrow(/Unknown provider/);
  });
});
