import { describe, expect, it } from "vitest";
import { maskCredentials, maskUrlQuery, urlQueryValues } from "../../src/log/mask.js";

describe("credential masking helpers", () => {
  it("replaces every occurrence of each credential with the fixed marker, keeping the scheme", () => {
    expect(maskCredentials("Bearer sk-abc, again sk-abc", ["sk-abc", ""])).toBe("Bearer [REDACTED], again [REDACTED]");
  });

  it("masks every query value of a URL and leaves a URL without one alone", () => {
    expect(maskUrlQuery("https://h.example/img.png?se=2026&sig=tok#frag")).toBe(
      "https://h.example/img.png?se=[REDACTED]&sig=[REDACTED]#frag",
    );
    expect(maskUrlQuery("https://h.example/img.png")).toBe("https://h.example/img.png");
    expect(maskUrlQuery("not a url")).toBe("not a url");
  });

  it("lists a URL's raw query values", () => {
    expect(urlQueryValues("https://h.example/a?se=2026-10-05&sig=a%2Bb&flag&empty=#x")).toEqual(["2026-10-05", "a%2Bb"]);
    expect(urlQueryValues("https://h.example/a")).toEqual([]);
  });
});
