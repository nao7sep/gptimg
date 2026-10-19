// The OpenAI key (api-key-storage-conventions): OPENAI_API_KEY first, then
// api-keys.json's `openai` entry in the obf: form, the file kept at 0600.
import { chmodSync, statSync } from "node:fs";
import { message, type Message } from "../shared/i18n/translator.ts";
import { json, readText, writeTextAtomic } from "./files.ts";

export const KEY_ID = "openai";
export const KEY_ENV = "OPENAI_API_KEY";

export function encodeKey(key: string): string {
  return `obf:${Buffer.from(Buffer.from(key, "utf8").reverse()).toString("base64")}`;
}

/** Decodes a stored value; plaintext without a marker is used as-is. Null for a malformed marked value. */
export function decodeKey(stored: string): string | null {
  if (!stored.startsWith("obf:")) return stored;
  const body = stored.slice(4);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body) || body.length % 4 !== 0) return null;
  return Buffer.from(Buffer.from(body, "base64").reverse()).toString("utf8");
}

type StoreRead =
  | { kind: "ok"; keys: Record<string, unknown>; raw: Record<string, unknown> }
  | { kind: "absent" }
  | { kind: "failed"; problem: Message };

export class KeyStore {
  #warnedMode = false;
  readonly file: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #warn: (event: string, fields: Record<string, unknown>) => void;

  constructor(file: string, env: NodeJS.ProcessEnv, warn: (event: string, fields: Record<string, unknown>) => void) {
    this.file = file;
    this.#env = env;
    this.#warn = warn;
  }

  async #read(): Promise<StoreRead> {
    this.#tighten();
    const read = await readText(this.file);
    if (read.kind === "absent") return { kind: "absent" };
    if (read.kind === "failed") return { kind: "failed", problem: message("key.problem.unreadable") };
    try {
      const raw = JSON.parse(read.text) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("shape");
      const keys = (raw as Record<string, unknown>).keys;
      if (keys !== undefined && (!keys || typeof keys !== "object" || Array.isArray(keys))) throw new Error("shape");
      return { kind: "ok", keys: (keys ?? {}) as Record<string, unknown>, raw: raw as Record<string, unknown> };
    } catch {
      return { kind: "failed", problem: message("key.problem.malformed") };
    }
  }

  /** Group- or world-readable: warn once and tighten to 0600. */
  #tighten(): void {
    if (process.platform === "win32") return;
    try {
      const mode = statSync(this.file).mode & 0o777;
      if ((mode & 0o077) === 0) return;
      chmodSync(this.file, 0o600);
      if (!this.#warnedMode) {
        this.#warnedMode = true;
        this.#warn("apiKeys.modeTightened", { mode: mode.toString(8) });
      }
    } catch {
      // Absent or unreadable: the read reports it.
    }
  }

  envValue(): string | null {
    const value = this.#env[KEY_ENV]?.trim();
    return value ? value : null;
  }

  /** The stored key, ignoring the environment, with why it is unavailable when it is. */
  async peek(): Promise<{ value: string | null; problem: Message | null }> {
    const read = await this.#read();
    if (read.kind === "absent") return { value: null, problem: null };
    if (read.kind === "failed") return { value: null, problem: read.problem };
    const stored = read.keys[KEY_ID];
    if (stored === undefined || stored === "") return { value: null, problem: null };
    if (typeof stored !== "string") return { value: null, problem: message("key.problem.malformed") };
    const decoded = decodeKey(stored);
    if (decoded === null) return { value: null, problem: message("key.problem.malformed") };
    const trimmed = decoded.trim();
    return { value: trimmed || null, problem: null };
  }

  async resolve(): Promise<string | null> {
    return this.envValue() ?? (await this.peek()).value;
  }

  async status(): Promise<{ source: "env" | "stored" | "none"; problem: Message | null }> {
    if (this.envValue()) return { source: "env", problem: null };
    const peeked = await this.peek();
    return { source: peeked.value ? "stored" : "none", problem: peeked.problem };
  }

  /** Stores the key; a file that cannot be read is not replaced. */
  async set(value: string): Promise<Message | null> {
    const trimmed = value.trim();
    if (!trimmed) return this.clear();
    const read = await this.#read();
    if (read.kind === "failed") return read.problem;
    const raw = read.kind === "ok" ? read.raw : {};
    const keys = read.kind === "ok" ? read.keys : {};
    await writeTextAtomic(this.file, json({ ...raw, keys: { ...keys, [KEY_ID]: encodeKey(trimmed) } }), 0o600);
    this.#tighten();
    return null;
  }

  async clear(): Promise<Message | null> {
    const read = await this.#read();
    if (read.kind === "absent") return null;
    if (read.kind === "failed") return read.problem;
    if (!Object.hasOwn(read.keys, KEY_ID)) return null;
    const { [KEY_ID]: _removed, ...rest } = read.keys;
    await writeTextAtomic(this.file, json({ ...read.raw, keys: rest }), 0o600);
    return null;
  }
}
