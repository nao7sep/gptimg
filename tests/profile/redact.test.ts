import { describe, expect, it } from "vitest";
import { redact } from "../../src/profile/redact.js";

describe("redact", () => {
  it("replaces top-level apiKey", () => {
    const input = { apiKey: "secret", other: "ok" };
    const out = redact(input);
    expect(out).toEqual({ apiKey: "[redacted]", other: "ok" });
  });

  it("replaces nested apiKey", () => {
    const input = { profile: { apiKey: "secret", model: "x" } };
    const out = redact(input);
    expect(out).toEqual({ profile: { apiKey: "[redacted]", model: "x" } });
  });

  it("replaces apiKey inside an array of objects", () => {
    const input = { profiles: [{ apiKey: "a" }, { apiKey: "b" }] };
    const out = redact(input);
    expect(out).toEqual({
      profiles: [{ apiKey: "[redacted]" }, { apiKey: "[redacted]" }],
    });
  });

  it("does not mutate the input", () => {
    const input = { apiKey: "secret", nested: { apiKey: "more" } };
    const snapshot = JSON.stringify(input);
    redact(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("preserves non-secret fields verbatim", () => {
    const input = {
      provider: "openai",
      model: "gpt-image-1",
      apiKeyEnv: "OPENAI_API_KEY",
      nested: { count: 3, list: [1, 2, 3] },
    };
    const out = redact(input);
    expect(out).toEqual(input);
  });

  it("redacts every seeded secret key, case-insensitively by whole name", () => {
    const input = {
      apiKey: "a",
      Authorization: "Bearer x",
      TOKEN: "t",
      Password: "p",
      secret: "s",
    };
    expect(redact(input)).toEqual({
      apiKey: "[redacted]",
      Authorization: "[redacted]",
      TOKEN: "[redacted]",
      Password: "[redacted]",
      secret: "[redacted]",
    });
  });

  it("matches whole keys only — never by substring", () => {
    // `tokenCount`/`broken` contain "token"; `apiKeyEnv` contains "apikey";
    // `secretsManager` contains "secret". None is an exact key, so all survive.
    const input = {
      tokenCount: 42,
      broken: true,
      apiKeyEnv: "OPENAI_API_KEY",
      secretsManager: "arn:...",
    };
    expect(redact(input)).toEqual(input);
  });

  it("handles null, undefined, primitives, and empty objects safely", () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
    expect(redact("plain")).toBe("plain");
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact({})).toEqual({});
    expect(redact([])).toEqual([]);
  });
});
