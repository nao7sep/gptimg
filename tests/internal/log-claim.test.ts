import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimDefaultLogPath, defaultLogPath, utcTimestampMs } from "../../src/internal/paths.js";

describe("claimDefaultLogPath", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "gptimg-log-claim-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("gives calls that start in the same millisecond consecutive milliseconds", async () => {
    const start = new Date(Date.UTC(2026, 9, 6, 1, 2, 3, 4));

    const claimed = await Promise.all(Array.from({ length: 5 }, () => claimDefaultLogPath(dir, start)));

    const expected = [0, 1, 2, 3, 4].map(offset =>
      defaultLogPath(dir, utcTimestampMs(new Date(start.getTime() + offset))),
    );
    expect([...claimed].sort()).toEqual(expected);
    expect((await readdir(dir)).sort()).toEqual(expected.map(file => path.basename(file)));
  });
});
