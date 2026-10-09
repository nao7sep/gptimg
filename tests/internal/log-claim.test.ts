import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimDefaultLogPath } from "../../src/internal/paths.js";

// Scripted IDs, so a collision is reproducible; the real generator is random.
const ids = vi.hoisted(() => ({ next: [] as string[] }));
vi.mock("nanoid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("nanoid")>()),
  customAlphabet: () => () => ids.next.shift() ?? "zzzzzz",
}));

describe("claimDefaultLogPath", () => {
  let dir: string;
  const start = new Date(Date.UTC(2026, 9, 6, 1, 2, 3, 4));

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "gptimg-log-claim-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("names the log by second and ID and creates it", async () => {
    ids.next = ["a1b2c3"];
    const claimed = await claimDefaultLogPath(dir, start);
    expect(claimed).toBe(path.join(dir, "20261006-010203-utc-a1b2c3.log"));
    expect(await readdir(dir)).toEqual(["20261006-010203-utc-a1b2c3.log"]);
  });

  it("draws a new ID when the name is already taken, keeping the same second", async () => {
    ids.next = ["aaaaaa", "aaaaaa", "bbbbbb"];
    const first = await claimDefaultLogPath(dir, start);
    const second = await claimDefaultLogPath(dir, start);
    expect(path.basename(first)).toBe("20261006-010203-utc-aaaaaa.log");
    expect(path.basename(second)).toBe("20261006-010203-utc-bbbbbb.log");
    expect((await readdir(dir)).sort()).toEqual(["20261006-010203-utc-aaaaaa.log", "20261006-010203-utc-bbbbbb.log"]);
  });

  it("returns the name unclaimed when the directory cannot hold it", async () => {
    ids.next = ["cccccc"];
    const missing = path.join(dir, "file-not-dir");
    await (await import("node:fs/promises")).writeFile(missing, "");
    const claimed = await claimDefaultLogPath(missing, start);
    expect(claimed).toBe(path.join(missing, "20261006-010203-utc-cccccc.log"));
  });
});
