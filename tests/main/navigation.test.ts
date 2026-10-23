import { describe, expect, it } from "vitest";
import { navigationAllowed } from "../../src/main/navigation.ts";

const development = "http://localhost:25793/index.html";

describe("renderer navigation boundary", () => {
  it("permits the exact development document, including query and fragment changes", () => {
    for (const candidate of [development, `${development}?view=records`, `${development}#images`, `${development}?view=records#selected`]) {
      expect(navigationAllowed(candidate, development)).toBe(true);
    }
  });

  it("rejects userinfo even when the apparent host points to the trusted origin", () => {
    for (const candidate of [
      "http://attacker@localhost:25793/index.html",
      "http://attacker:secret@localhost:25793/index.html",
      "http://localhost:25793@attacker.example/index.html",
    ]) expect(navigationAllowed(candidate, development)).toBe(false);
  });

  it("rejects another origin, port, protocol or document path", () => {
    for (const candidate of [
      "http://attacker.example:25793/index.html",
      "http://localhost:25794/index.html",
      "https://localhost:25793/index.html",
      "http://127.0.0.1:25793/index.html",
      "http://localhost:25793/other.html",
      "http://localhost:25793/index.html/child",
      "http://localhost:25793/index.html.attacker",
      "file:///index.html",
      "data:text/html,hello",
      "javascript:alert(1)",
    ]) expect(navigationAllowed(candidate, development)).toBe(false);
  });

  it("rejects malformed candidates and invalid development URLs", () => {
    for (const candidate of ["", "not a URL", "/index.html", "http://[malformed"]) {
      expect(navigationAllowed(candidate, development)).toBe(false);
    }
    expect(navigationAllowed(development, "malformed")).toBe(false);
  });

  it("rejects all in-place navigation in production when no development URL exists", () => {
    for (const candidate of [development, "file:///Applications/GptImg/index.html", "https://example.com/"]) {
      expect(navigationAllowed(candidate, undefined)).toBe(false);
      expect(navigationAllowed(candidate, "")).toBe(false);
    }
  });
});
