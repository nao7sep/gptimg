import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GptImg } from "../../src/gptimg.js";
import { defaultModelsDir } from "../../src/internal/paths.js";
import { MODELS, type ModelKey } from "../../src/local/models/registry.js";
import { captureStderr } from "../helpers/streams.js";

// `model install` routes through the shared logger envelope, so it opens a log
// file (mkdir'ing its parent) before doing any work. The first test pins the
// `--log`/`log` redirect (a caller can choose where that file goes); the second
// pins the fallback contract — an unwritable default log dir announces the
// failure to stderr once and never fails the install, since the cache and network
// are fine. A cache hit logs nothing, so we assert on the directory `openLog`
// creates, not on a written log line.

describe("installModelImpl logging", () => {
  let tmp: string;
  const key = (Object.keys(MODELS) as ModelKey[])[0]!;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-model-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  /** Pre-seed the model cache so `ensureModel` short-circuits — no network. */
  async function seedCachedModel(profileDir: string): Promise<void> {
    const modelsDir = defaultModelsDir(profileDir);
    await mkdir(modelsDir, { recursive: true });
    const modelPath = path.join(modelsDir, MODELS[key].name);
    await writeFile(modelPath, Buffer.alloc(0));
    await truncate(modelPath, MODELS[key].byteSize);
  }

  it("routes the log to an explicit path and leaves the default log dir untouched", async () => {
    const profileDir = path.join(tmp, "profile");
    const logDir = path.join(tmp, "logs");
    await seedCachedModel(profileDir);
    const customLog = path.join(tmp, "custom", "install.jsonl");

    const sdk = new GptImg({ profileDir, logDir });
    const result = await sdk.model.install(key, { log: customLog });

    expect(result.name).toBe(MODELS[key].name);
    expect(result.forced).toBe(false);
    // openLog mkdir'd the custom path's parent — proof the redirect was used...
    expect(existsSync(path.dirname(customLog))).toBe(true);
    // ...and the default log dir was never opened.
    const defaultEntries = existsSync(logDir) ? await readdir(logDir) : [];
    expect(defaultEntries).toEqual([]);
  });

  it("a default log dir that can't be opened never fails install, and the SDK never prints", async () => {
    const profileDir = path.join(tmp, "profile");
    await seedCachedModel(profileDir);
    // Point the default log dir under a *file*, so opening its log (mkdir of the
    // parent) fails with ENOTDIR — the unwritable-default-path scenario.
    const blocker = path.join(tmp, "blocker");
    await writeFile(blocker, "not a dir");
    const logDir = path.join(blocker, "logs");

    let result: { name: string } | undefined;
    const chunks = await captureStderr(async () => {
      // The logger can't open its file, but that must not fail the install — the
      // cache and network are fine, so the work goes on regardless.
      const sdk = new GptImg({ profileDir, logDir });
      result = await sdk.model.install(key);
    });

    expect(result?.name).toBe(MODELS[key].name);
    // The log file is unavailable, but an SDK never falls back to a standard stream
    // (sdk-toolkit-conventions §4); with no progress sink supplied here, it is silent.
    expect(chunks.join("")).toBe("");
  });

  it("rejects a truthy string force flag before logging or downloading", async () => {
    const profileDir = path.join(tmp, "profile");
    const logDir = path.join(tmp, "logs");
    const sdk = new GptImg({ profileDir, logDir });

    await expect(sdk.model.install(key, { force: "false" } as never)).rejects.toMatchObject({
      code: "args.invalid",
    });
    expect(existsSync(logDir)).toBe(false);
    expect(existsSync(defaultModelsDir(profileDir))).toBe(false);
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
    await rm(tmp, { recursive: true, force: true });
  });

  it("installAll wraps the per-model results in a single { installed } object", async () => {
    const profileDir = path.join(tmp, "profile");
    // Seed every model so each ensureModel is a cache hit — no network.
    const modelsDir = defaultModelsDir(profileDir);
    await mkdir(modelsDir, { recursive: true });
    for (const key of keys) {
      const modelPath = path.join(modelsDir, MODELS[key].name);
      await writeFile(modelPath, Buffer.alloc(0));
      await truncate(modelPath, MODELS[key].byteSize);
    }

    const sdk = new GptImg({ profileDir, logDir: path.join(tmp, "logs") });
    const result = await sdk.model.installAll();

    expect(Array.isArray(result)).toBe(false);
    expect(result.installed.map((m) => m.key)).toEqual(keys);
    expect(result.installed.every((m) => m.forced === false)).toBe(true);
  });

  it("list wraps entries in a single { models } object carrying cache state", async () => {
    const profileDir = path.join(tmp, "profile");
    const modelsDir = defaultModelsDir(profileDir);
    await mkdir(modelsDir, { recursive: true });
    // Seed only the first model so both a cached and an uncached entry appear.
    const cachedEntry = MODELS[keys[0]!];
    const cachedPath = path.join(modelsDir, cachedEntry.name);
    await writeFile(cachedPath, Buffer.alloc(0));
    await truncate(cachedPath, cachedEntry.byteSize);

    const sdk = new GptImg({ profileDir, logDir: path.join(tmp, "logs") });
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
    await rm(tmp, { recursive: true, force: true });
  });

  it("reports a missing model when nothing is cached", async () => {
    const profileDir = path.join(tmp, "profile");
    const sdk = new GptImg({ profileDir, logDir: path.join(tmp, "logs") });

    const result = await sdk.model.verify();

    const entry = result.models.find((m) => m.key === key)!;
    expect(entry.integrity).toBe("missing");
    expect(entry.actualSha256).toBeUndefined();
    expect(entry.expectedSha256).toBe(MODELS[key].sha256);
  });

  it("does not report a wrong-sized pinned artifact as cached", async () => {
    const profileDir = path.join(tmp, "profile");
    const modelsDir = defaultModelsDir(profileDir);
    await mkdir(modelsDir, { recursive: true });
    await writeFile(path.join(modelsDir, MODELS[key].name), Buffer.from([1, 2, 3]));

    const result = new GptImg({ profileDir }).model.list();
    const entry = result.models.find((model) => model.key === key);
    expect(entry?.cached).toBe(false);
    expect(entry?.sizeBytes).toBe(3);
  });

  it("honors an already-aborted signal", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("stop"));
    const profileDir = path.join(tmp, "profile");
    const sdk = new GptImg({ profileDir });

    await expect(sdk.model.verify({ signal: ctrl.signal })).rejects.toMatchObject({
      code: "cancelled",
    });
  });

  it("reports a mismatch when a cached file's bytes do not match the pinned sha256", async () => {
    const profileDir = path.join(tmp, "profile");
    const modelsDir = defaultModelsDir(profileDir);
    await mkdir(modelsDir, { recursive: true });
    // A real model is ~0.5 GB; a few wrong bytes prove the hash is recomputed and
    // compared, not trusted from presence alone.
    await writeFile(path.join(modelsDir, MODELS[key].name), Buffer.from([1, 2, 3]));

    const sdk = new GptImg({ profileDir, logDir: path.join(tmp, "logs") });
    const result = await sdk.model.verify();

    const entry = result.models.find((m) => m.key === key)!;
    expect(entry.integrity).toBe("mismatch");
    expect(entry.actualSha256).toBeDefined();
    expect(entry.actualSha256).not.toBe(MODELS[key].sha256);
  });

  it("returns a log path and streams bounded progress for a tiny fixture", async () => {
    const profileDir = path.join(tmp, "profile");
    const modelsDir = defaultModelsDir(profileDir);
    await mkdir(modelsDir, { recursive: true });
    await writeFile(path.join(modelsDir, MODELS[key].name), Buffer.from([1, 2, 3]));
    const onProgress = vi.fn();
    const sdk = new GptImg({ profileDir, logDir: path.join(tmp, "logs") });

    const result = await sdk.model.verify({ onProgress });

    expect(result.logPath).toMatch(/\.log$/);
    expect(existsSync(result.logPath)).toBe(true);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "verifying cached model",
        stage: "resolve",
      }),
    );
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "model verification result",
        stage: "response",
      }),
    );
  });

  it("wraps cached-model filesystem failures in the stable typed error", async () => {
    const profileDir = path.join(tmp, "verify-failure-profile");
    const modelPath = path.join(defaultModelsDir(profileDir), MODELS[key].name);
    await mkdir(modelPath, { recursive: true });
    const sdk = new GptImg({
      profileDir,
      logDir: path.join(tmp, "verify-failure-logs"),
    });

    await expect(sdk.model.verify()).rejects.toMatchObject({
      code: "model.verifyFailed",
      errorType: "localOp",
      cause: expect.any(Error),
    });
  });
});
