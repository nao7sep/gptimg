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
