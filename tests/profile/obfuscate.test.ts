import { describe, expect, it } from "vitest";
import { deobfuscate, obfuscate } from "../../src/profile/obfuscate.js";

describe("obfuscate / deobfuscate", () => {
  it("round-trips a typical API key", () => {
    const raw = "sk-test-1234567890abcdefghijk";
    const stored = obfuscate(raw);
    expect(stored.startsWith("obf:")).toBe(true);
    expect(stored).not.toContain(raw);
    expect(deobfuscate(stored)).toBe(raw);
  });

  it("round-trips a unicode value", () => {
    const raw = "key-日本語-🔑-ñ";
    expect(deobfuscate(obfuscate(raw))).toBe(raw);
  });

  it("returns raw value when marker is absent", () => {
    expect(deobfuscate("sk-plain-key")).toBe("sk-plain-key");
  });

  it("does not collide with raw values that happen to start with 'obf'", () => {
    // 'obfuscated' (no colon) is not the marker.
    expect(deobfuscate("obfuscated")).toBe("obfuscated");
  });

  it("encodes by reversing UTF-8 bytes (canonical cross-language vectors)", () => {
    // Locked so a decoder in another language must match byte-for-byte, per the
    // api-key-storage convention's `obf:` algorithm. ASCII is identical to a
    // character reverse; the unicode vector is where byte-reverse is canonical.
    expect(obfuscate("sk-test")).toBe("obf:dHNldC1rcw==");
    expect(obfuscate("key-日本語-🔑-ñ")).toBe("obf:scMtkZSf8C2equisnOall+YteWVr");
  });
});
