import { describe, expect, it } from "vitest";
import { createContext, requireCredentials } from "../../src/context.ts";

describe("the baseURL option", () => {
  it("is passed with the credentials, without a trailing slash", () => {
    const ctx = createContext({ apiKey: "sk-x", baseURL: " https://proxy.example/v1/ " });
    expect(requireCredentials(ctx)).toEqual({ apiKey: "sk-x", baseURL: "https://proxy.example/v1" });
  });

  it("is left out when not given, so OpenAI's own applies", () => {
    expect(requireCredentials(createContext({ apiKey: "sk-x" }))).toEqual({ apiKey: "sk-x" });
  });

  it("refuses a value that is not an http(s) URL", () => {
    expect(() => createContext({ baseURL: "api.openai.com/v1" })).toThrow(/http or https URL/);
  });
});

describe("checking before the key", () => {
  it("reports a value the model does not take before asking for a key", async () => {
    const { GptImg } = await import("../../src/index.ts");
    const img = new GptImg();
    await expect(
      img.generate({ prompt: "x", outDir: "/tmp/gptimg-never-written", policy: { generate: { model: "gpt-image-2", quality: "max" } } }),
    ).rejects.toMatchObject({ code: "policy.invalid" });
    await expect(
      img.chat({ message: "x", outDir: "/tmp/gptimg-never-written", policy: { chat: { model: "gpt-6-astra", reasoning: "none" } } }),
    ).rejects.toMatchObject({ code: "policy.invalid" });
    await expect(img.generate({ prompt: "x", outDir: "/tmp/gptimg-never-written" })).rejects.toMatchObject({ code: "apiKey.missing" });
  });
});
