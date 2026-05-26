import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { hash } from "../../src/image/hash.js";

describe("hash", () => {
  it("matches the published SHA-256 of 'abc'", () => {
    expect(hash(Buffer.from("abc", "utf-8"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches the published SHA-256 of the empty string", () => {
    expect(hash(Buffer.alloc(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("is deterministic for the same input", () => {
    const a = hash(Buffer.from("repeatable"));
    const b = hash(Buffer.from("repeatable"));
    expect(a).toBe(b);
  });

  it("differs for different inputs", () => {
    expect(hash(Buffer.from("x"))).not.toBe(hash(Buffer.from("y")));
  });

  it("accepts a Uint8Array", () => {
    expect(hash(new Uint8Array([97, 98, 99]))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
