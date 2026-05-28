import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AbortError, GptImg } from "../../src/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "fixtures");

function fixture(name: string): string {
  return path.join(FIXTURES, name);
}

describe("SDK abort errors", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-abort-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("rejects with the exported AbortError shape", async () => {
    const sdk = new GptImg({ profileDir: tmp, logDir: tmp });
    const ctrl = new AbortController();
    ctrl.abort(new Error("stop"));

    await expect(
      sdk.chroma(
        {
          in: fixture("green-disk.png"),
          log: path.join(tmp, "chroma.log"),
        },
        { signal: ctrl.signal },
      ),
    ).rejects.toMatchObject({
      name: "AbortError",
      errorType: "abort",
      code: "cancelled",
      message: "stop",
    });

    await expect(
      sdk.chroma(
        {
          in: fixture("green-disk.png"),
          log: path.join(tmp, "chroma-2.log"),
        },
        { signal: ctrl.signal },
      ),
    ).rejects.toBeInstanceOf(AbortError);
  });
});
