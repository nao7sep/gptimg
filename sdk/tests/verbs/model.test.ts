import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GptImg } from "../../src/gptimg.ts";
import { MODELS, type ModelKey } from "../../src/local/models/registry.ts";
import { captureStderr } from "../helpers/streams.ts";

// `model install` routes through the shared logger envelope, so with a log it
// opens the log file (mkdir'ing its parent) before doing any work. The first test
// pins the `log` call option; the second pins the fallback contract: a log folder
// that cannot be opened never fails the install and the SDK prints nothing.
// Every suite passes its own temporary models folder.

describe("installModelImpl logging", () => {
  let tmp: string;
  const key = (Object.keys(MODELS) as ModelKey[])[0]!;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-model-"));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tmp, { recursive: true, force: true });
  });

  /** Pre-seed the model cache so `ensureModel` short-circuits — no network. */
  async function seedCachedModel(homeDir: string): Promise<void> {
    const modelsDir = path.join(homeDir, "models");
    await mkdir(modelsDir, { recursive: true });
    const modelPath = path.join(modelsDir, MODELS[key].name);
    await writeFile(modelPath, Buffer.alloc(0));
    await truncate(modelPath, MODELS[key].byteSize);
  }

  it("installs an already cached model without downloading, writes nothing else, and never prints", async () => {
    const homeDir = path.join(tmp, "home");
    await seedCachedModel(homeDir);
    let result: { installed: Array<{ name: string; forced: boolean }> } | undefined;
    const chunks = await captureStderr(async () => {
      result = await new GptImg({ modelsDir: path.join(homeDir, "models") }).model.install(key);
    });
    expect(result?.installed[0]).toMatchObject({ name: MODELS[key].name, forced: false });
    expect(chunks.join("")).toBe("");
    expect(await readdir(tmp)).toEqual(["home"]);
  });

  it("rejects a truthy string force flag and the retired log option before downloading", async () => {
    const homeDir = path.join(tmp, "home");
    const sdk = new GptImg({ modelsDir: path.join(homeDir, "models") });

    await expect(sdk.model.install(key, { force: "false" } as never)).rejects.toMatchObject({
      code: "args.invalid",
    });
    await expect(sdk.model.install(key, { log: { file: path.join(tmp, "x.log") } } as never)).rejects.toMatchObject({
      code: "args.invalid",
      details: { field: "log", constraint: "retired" },
    });
    expect(existsSync(path.join(homeDir, "models"))).toBe(false);
  });
});

// Per §4 (return typed data, never a bare primary value), the install/list SDK
// methods each return one wrapper object — never a bare array. These pin those
// shapes: `installAll` → { installed }, `list` → { models }.
describe("model verb result shapes", () => {
  let tmp: string;
  const keys = Object.keys(MODELS) as ModelKey[];

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-model-shape-"));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tmp, { recursive: true, force: true });
  });

  it("installAll wraps the per-model results in a single { installed } object", async () => {
    const homeDir = path.join(tmp, "home");
    // Seed every model so each ensureModel is a cache hit — no network.
    const modelsDir = path.join(homeDir, "models");
    await mkdir(modelsDir, { recursive: true });
    for (const key of keys) {
      const modelPath = path.join(modelsDir, MODELS[key].name);
      await writeFile(modelPath, Buffer.alloc(0));
      await truncate(modelPath, MODELS[key].byteSize);
    }

    const sdk = new GptImg({ modelsDir: path.join(homeDir, "models") });
    const result = await sdk.model.installAll();

    expect(Array.isArray(result)).toBe(false);
    expect(result.installed.map((m) => m.key)).toEqual(keys);
    expect(result.installed.every((m) => m.forced === false)).toBe(true);
  });

  it("list wraps entries in a single { models } object carrying cache state", async () => {
    const homeDir = path.join(tmp, "home");
    const modelsDir = path.join(homeDir, "models");
    await mkdir(modelsDir, { recursive: true });
    // Seed only the first model so both a cached and an uncached entry appear.
    const cachedEntry = MODELS[keys[0]!];
    const cachedPath = path.join(modelsDir, cachedEntry.name);
    await writeFile(cachedPath, Buffer.alloc(0));
    await truncate(cachedPath, cachedEntry.byteSize);

    const sdk = new GptImg({ modelsDir: path.join(homeDir, "models") });
    const result = sdk.model.list();

    expect(Array.isArray(result)).toBe(false);
    expect(result.models.map((m) => m.key)).toEqual(keys);
    const cached = result.models.find((m) => m.key === keys[0]);
    expect(cached?.cached).toBe(true);
    expect(typeof cached?.sizeBytes).toBe("number");
    if (keys.length > 1) {
      const uncached = result.models.find((m) => m.key === keys[1]);
      expect(uncached?.cached).toBe(false);
      expect(uncached?.sizeBytes).toBeUndefined();
    }
  });
});

describe("model.verify integrity check", () => {
  let tmp: string;
  const key = (Object.keys(MODELS) as ModelKey[])[0]!;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-verify-"));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tmp, { recursive: true, force: true });
  });

  it("reports a missing model when nothing is cached", async () => {
    const homeDir = path.join(tmp, "home");
    const sdk = new GptImg({ modelsDir: path.join(homeDir, "models") });

    const result = await sdk.model.verify();

    const entry = result.models.find((m) => m.key === key)!;
    expect(entry.integrity).toBe("missing");
    expect(entry.actualSha256).toBeUndefined();
    expect(entry.expectedSha256).toBe(MODELS[key].sha256);
  });

  it("does not report a wrong-sized pinned artifact as cached", async () => {
    const homeDir = path.join(tmp, "home");
    const modelsDir = path.join(homeDir, "models");
    await mkdir(modelsDir, { recursive: true });
    await writeFile(path.join(modelsDir, MODELS[key].name), Buffer.from([1, 2, 3]));

    const result = new GptImg({ modelsDir: path.join(homeDir, "models") }).model.list();
    const entry = result.models.find((model) => model.key === key);
    expect(entry?.cached).toBe(false);
    expect(entry?.sizeBytes).toBe(3);
  });

  it("honors an already-aborted signal", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("stop"));
    const homeDir = path.join(tmp, "home");
    const sdk = new GptImg({ modelsDir: path.join(homeDir, "models") });

    await expect(sdk.model.verify({ signal: ctrl.signal })).rejects.toMatchObject({
      code: "cancelled",
    });
  });

  it("reports a mismatch when a cached file's bytes do not match the pinned sha256", async () => {
    const homeDir = path.join(tmp, "home");
    const modelsDir = path.join(homeDir, "models");
    await mkdir(modelsDir, { recursive: true });
    // A real model is ~0.5 GB; a few wrong bytes prove the hash is recomputed and
    // compared, not trusted from presence alone.
    await writeFile(path.join(modelsDir, MODELS[key].name), Buffer.from([1, 2, 3]));

    const sdk = new GptImg({ modelsDir: path.join(homeDir, "models") });
    const result = await sdk.model.verify();

    const entry = result.models.find((m) => m.key === key)!;
    expect(entry.integrity).toBe("mismatch");
    expect(entry.actualSha256).toBeDefined();
    expect(entry.actualSha256).not.toBe(MODELS[key].sha256);
  });

  it("reports verification as events and streams bounded progress for a tiny fixture", async () => {
    const homeDir = path.join(tmp, "home");
    const modelsDir = path.join(homeDir, "models");
    await mkdir(modelsDir, { recursive: true });
    await writeFile(path.join(modelsDir, MODELS[key].name), Buffer.from([1, 2, 3]));
    const onEvent = vi.fn();
    const onProgress = vi.fn();
    const sdk = new GptImg({ modelsDir: path.join(homeDir, "models") });

    const result = await sdk.model.verify({ onEvent, onProgress });

    expect(result.models.length).toBeGreaterThan(0);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "model.verify.start", stage: "resolve" }));
    expect(onProgress).toHaveBeenLastCalledWith({ verb: "model", stage: "hash", done: 3, total: 3, unit: "bytes", subject: expect.any(String) });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "model.verify.done", stage: "response" }));
  });

  it("wraps cached-model filesystem failures in the stable typed error", async () => {
    const homeDir = path.join(tmp, "verify-failure-home");
    const modelPath = path.join(path.join(homeDir, "models"), MODELS[key].name);
    await mkdir(modelPath, { recursive: true });
    const sdk = new GptImg({
      modelsDir: path.join(homeDir, "models"),
    });

    // A folder where the model file belongs cannot be hashed: the filesystem's cause, with the path.
    await expect(sdk.model.verify()).rejects.toMatchObject({
      kind: "unavailable",
      code: expect.stringMatching(/^fs\./),
      subject: modelPath,
      cause: expect.any(Error),
    });
  });
});

describe("models install only on request", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-model-required-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("AI masking and upscaling refuse to start without the model and name the install call, downloading nothing", async () => {
    const input = path.join(tmp, "in.png");
    await writeFile(input, await readFile(new URL("../fixtures/green-disk.png", import.meta.url)));
    const modelsDir = path.join(tmp, "models");
    const sdk = new GptImg({ modelsDir });
    await expect(sdk.mask({ in: input, method: "ai" })).rejects.toMatchObject({
      code: "model.notInstalled",
      kind: "unavailable",
      message: expect.stringContaining('img.model.install("birefnet")'),
    });
    await expect(sdk.upscale({ in: input })).rejects.toMatchObject({
      code: "model.notInstalled",
      message: expect.stringContaining('img.model.install("swin2sr")'),
    });
    expect(existsSync(modelsDir)).toBe(false);
  });

  it("uses a call's own models folder over the instance's, so several folders work side by side", async () => {
    const sdk = new GptImg({ modelsDir: path.join(tmp, "a") });
    const listed = sdk.model.list({ modelsDir: path.join(tmp, "b") });
    expect(listed.models.every((m) => m.path.startsWith(path.join(tmp, "b")))).toBe(true);
    expect(() => sdk.model.list({ modelsDir: "relative" })).toThrow(expect.objectContaining({ code: "args.invalid" }));
  });
});
