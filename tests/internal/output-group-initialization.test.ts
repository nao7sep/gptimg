import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const claimPublishGate = vi.hoisted(() => ({
  armed: false,
  reached: undefined as (() => void) | undefined,
  releasePromise: Promise.resolve(),
}));

// Windows' rename never replaces an existing directory, even an empty one.
const windowsRename = vi.hoisted(() => ({ on: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (oldPath: string, newPath: string): Promise<void> => {
      if (claimPublishGate.armed && oldPath.includes(".lock.claim-") && newPath.endsWith(".lock")) {
        claimPublishGate.armed = false;
        claimPublishGate.reached?.();
        await claimPublishGate.releasePromise;
      }
      if (windowsRename.on && (await actual.stat(newPath).catch(() => undefined))?.isDirectory()) {
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${oldPath}' -> '${newPath}'`), {
          code: "EPERM",
        });
      }
      await actual.rename(oldPath, newPath);
    },
  };
});

import { acquireOutputGroupLock, createOutputGroup, outputGroupLockPathFor } from "../../src/internal/output-group.js";

describe("output reservation initialization", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-group-init-"));
  });

  afterEach(async () => {
    claimPublishGate.armed = false;
    windowsRename.on = false;
    await rm(tmp, { recursive: true, force: true });
  });

  it("keeps a paused initialized claim private until its atomic publication", async () => {
    let markReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      markReached = resolve;
    });
    let resume!: () => void;
    claimPublishGate.releasePromise = new Promise<void>((resolve) => {
      resume = resolve;
    });
    claimPublishGate.reached = markReached;
    claimPublishGate.armed = true;

    const group = createOutputGroup(tmp, "paused", "png");
    const lockPath = await outputGroupLockPathFor(group);
    const firstPromise = acquireOutputGroupLock(group);
    await reached;

    expect(existsSync(lockPath)).toBe(false);
    const claimName = (await readdir(tmp)).find((name) => name.includes(".lock.claim-"));
    expect(claimName).toBeDefined();
    expect(await readdir(path.join(tmp, claimName!))).toEqual([expect.stringMatching(/^held-[A-Za-z0-9_-]{21}$/)]);

    const second = await acquireOutputGroupLock(group);
    resume();
    await expect(firstPromise).rejects.toMatchObject({ code: "output.busy" });
    await second.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("recovers an empty lock, left by a release stopped before its rmdir, where rename cannot replace it", async () => {
    windowsRename.on = true;
    const group = createOutputGroup(tmp, "emptied", "png");
    const lockPath = await outputGroupLockPathFor(group);
    await mkdir(lockPath);

    const lock = await acquireOutputGroupLock(group);
    await lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });
});
