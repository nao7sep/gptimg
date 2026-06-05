import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GptImg } from "../../src/gptimg.js";
import { defaultModelsDir } from "../../src/internal/paths.js";
import { MODELS, type ModelKey } from "../../src/local/models/registry.js";

// `model install` routes through the shared logger envelope, so it opens a log
// file (mkdir'ing its parent) before doing any work. These tests pin the
// `--log`/`log` escape hatch that lets a caller redirect that path — without
// it, an unwritable default log dir would fail the install even though the
// cache and network are fine. A cache hit logs nothing, so we assert on the
// directory `openLog` creates, not on a written log line.

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

  it("an explicit log path is an escape hatch when the default log dir can't be opened", async () => {
    const profileDir = path.join(tmp, "profile");
    await seedCachedModel(profileDir);
    // Point the default log dir under a *file*, so opening its log (mkdir of the
    // parent) fails with ENOTDIR — the unwritable-default-path scenario.
    const blocker = path.join(tmp, "blocker");
    await writeFile(blocker, "not a dir");
    const logDir = path.join(blocker, "logs");

    // Without a redirect, install fails purely at logger open.
    const blocked = new GptImg({ profileDir, logDir });
    await expect(blocked.model.install(key)).rejects.toMatchObject({ code: "log.openFailed" });

    // With a writable `log`, the same install succeeds — the default path is
    // never consulted, so the unwritable dir no longer matters.
    const writableLog = path.join(tmp, "ok.jsonl");
    const rescued = new GptImg({ profileDir, logDir });
    const result = await rescued.model.install(key, { log: writableLog });
    expect(result.name).toBe(MODELS[key].name);
  });
});
