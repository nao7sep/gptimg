import { describe, expect, it } from "vitest";
import { getProvider } from "../../src/providers/index.js";
import { buildOpenAIClient, resolveModel } from "../../src/providers/openai/client.js";
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

  it("resolves model precedence from params to profile to fallback", () => {
    expect(resolveModel("param-model", "profile-model", "fallback")).toBe(
      "param-model",
    );
    expect(resolveModel(undefined, "profile-model", "fallback")).toBe(
      "profile-model",
    );
    expect(resolveModel("", "", "fallback")).toBe("fallback");
  });

  it("returns the OpenAI provider and rejects unknown providers", () => {
    expect(getProvider("openai").name).toBe("openai");
    expect(() => getProvider("nope")).toThrow(/Unknown provider/);
  });
});
