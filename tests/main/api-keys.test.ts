import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeKey, encodeKey, KeyStore } from "../../src/main/api-keys.ts";

function store(env: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gptimg-keys-"));
  const warnings: string[] = [];
  return { file: join(dir, "api-keys.json"), keys: new KeyStore(join(dir, "api-keys.json"), env, (e) => warnings.push(e)), warnings };
}

describe("key encoding", () => {
  it("reverses the UTF-8 bytes and base64-encodes them behind obf:", () => {
    expect(encodeKey("abc")).toBe(`obf:${Buffer.from("cba").toString("base64")}`);
    expect(decodeKey(encodeKey("sk-é-123"))).toBe("sk-é-123");
  });

  it("uses a value without a marker as plaintext and refuses a malformed marked one", () => {
    expect(decodeKey("sk-plain")).toBe("sk-plain");
    expect(decodeKey("obf:%%%")).toBeNull();
  });
});

describe("key store", () => {
  it("resolves the environment first, and peek edits only what is stored", async () => {
    const { keys } = store({ OPENAI_API_KEY: "  env-key  " });
    await keys.set("stored-key");
    expect(await keys.resolve()).toBe("env-key");
    expect((await keys.peek()).value).toBe("stored-key");
    expect((await keys.status()).source).toBe("env");
  });

  it("writes the obf: form in a 0600 file and clears it", async () => {
    const { keys, file } = store();
    await keys.set("sk-test");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ keys: { openai: encodeKey("sk-test") } });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    await keys.clear();
    expect(await keys.resolve()).toBeNull();
  });

  it("never replaces a file it cannot understand", async () => {
    const { keys, file } = store();
    writeFileSync(file, "{not json", { mode: 0o600 });
    expect(await keys.set("sk-new")).toEqual({ key: "key.problem.malformed" });
    expect(readFileSync(file, "utf8")).toBe("{not json");
  });

  it.skipIf(process.platform === "win32")("warns once and tightens a readable file", async () => {
    const { keys, file, warnings } = store();
    await keys.set("sk-test");
    chmodSync(file, 0o644);
    await keys.peek();
    await keys.peek();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(warnings).toEqual(["apiKeys.modeTightened"]);
  });

  it("keeps other keys in the file", async () => {
    const { keys, file } = store();
    writeFileSync(file, JSON.stringify({ keys: { gemini: "obf:x" } }), { mode: 0o600 });
    await keys.set("sk-test");
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).keys).sort()).toEqual(["gemini", "openai"]);
  });
});
