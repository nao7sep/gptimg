import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    await writeFile(path.join(modelsDir, MODELS[key].name), Buffer.from([1, 2, 3]));
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

  it("a default log dir that can't be opened is announced once, never failing install", async () => {
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
      // cache and network are fine, so the failure is announced and work goes on.
      const sdk = new GptImg({ profileDir, logDir });
      result = await sdk.model.install(key);
    });

    expect(result?.name).toBe(MODELS[key].name);
    // The logging failure surfaces on stderr rather than being swallowed.
    expect(chunks.join("")).toContain('"message":"log file unavailable"');
  });
});

// The CLI renders whatever the SDK returns as the single stdout JSON object
// (sdk-cli §4), so the install/list SDK methods must each return one wrapper
// object — never a bare array. These pin those shapes: `installAll` → { installed },
// `list` → { models }.
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
      await writeFile(path.join(modelsDir, MODELS[key].name), Buffer.from([1, 2, 3]));
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
    await writeFile(path.join(modelsDir, MODELS[keys[0]!].name), Buffer.from([1, 2, 3]));

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
