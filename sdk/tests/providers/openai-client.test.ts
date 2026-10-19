import { describe, expect, it, vi } from "vitest";
import { getProvider } from "../../src/providers/index.ts";
import { buildOpenAIClient, clientHeaders, resolveModel } from "../../src/providers/openai/client.ts";
import type { Credentials } from "../../src/types.ts";

describe("OpenAI client helpers", () => {
  it("constructs the SDK client from the given credentials without SDK retries", () => {
    const credentials: Credentials = { apiKey: "sk-local", organization: "org-local", project: "proj-local" };

    const client = buildOpenAIClient(credentials);

    expect(client.apiKey).toBe("sk-local");
    expect(client.organization).toBe("org-local");
    expect(client.project).toBe("proj-local");
    expect(client.maxRetries).toBe(0);
  });

  it("records the identity headers the client sends and ignores every ambient OpenAI variable", () => {
    vi.stubEnv("OPENAI_ORG_ID", "org-env");
    vi.stubEnv("OPENAI_PROJECT_ID", "proj-env");
    vi.stubEnv("OPENAI_BASE_URL", "https://ambient.invalid/v1");
    vi.stubEnv("OPENAI_ADMIN_KEY", "sk-admin-ambient");
    vi.stubEnv("OPENAI_API_KEY", "sk-ambient");
    try {
      const bare = buildOpenAIClient({ apiKey: "sk-local" });
      expect(clientHeaders(bare)).toEqual({ Authorization: "Bearer sk-local" });
      expect(bare.baseURL).toBe("https://api.openai.com/v1");
      expect(bare.adminAPIKey ?? null).toBeNull();
      const given = buildOpenAIClient({ apiKey: "sk-local", organization: "org-local", project: "proj-local" });
      expect(clientHeaders(given)).toEqual({
        Authorization: "Bearer sk-local",
        "OpenAI-Organization": "org-local",
        "OpenAI-Project": "proj-local",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("sends to the caller's base URL when given one", () => {
    expect(buildOpenAIClient({ apiKey: "sk-local", baseURL: "https://proxy.example/v1" }).baseURL).toBe("https://proxy.example/v1");
  });

  it("records no organization or project header when neither the caller nor the environment sets one", () => {
    vi.stubEnv("OPENAI_ORG_ID", undefined);
    vi.stubEnv("OPENAI_PROJECT_ID", undefined);
    try {
      const client = buildOpenAIClient({ apiKey: "sk-local" });
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

  it("returns the OpenAI provider", () => {
    expect(getProvider().name).toBe("openai");
  });
});
