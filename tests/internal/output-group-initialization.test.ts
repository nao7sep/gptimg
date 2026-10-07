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
const markerWriteFailure = vi.hoisted(() => ({
  error: undefined as NodeJS.ErrnoException | undefined,
  endpoint: undefined as string | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>): Promise<void> => {
      await actual.writeFile(...args);
      const markerPath = String(args[0]);
      if (markerWriteFailure.error && path.basename(markerPath).startsWith("held-")) {
        const token = path.basename(markerPath).slice("held-".length);
        const lockPath = path.dirname(markerPath).split(".claim-")[0]!;
        markerWriteFailure.endpoint = guardianEndpointFor(lockPath, token, String(args[1]));
        throw markerWriteFailure.error;
      }
    },
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

import { acquireOutputGroupLock, createOutputGroup, guardianEndpointFor, outputGroupLockPathFor } from "../../src/internal/output-group.js";

describe("output reservation initialization", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-group-init-"));
  });

  afterEach(async () => {
    claimPublishGate.armed = false;
    windowsRename.on = false;
    markerWriteFailure.error = undefined;
    markerWriteFailure.endpoint = undefined;
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
    const firstSettled = firstPromise.then((lock) => lock, () => undefined);
    let second: Awaited<ReturnType<typeof acquireOutputGroupLock>> | undefined;
    try {
      await reached;
      expect(existsSync(lockPath)).toBe(false);
      const claimName = (await readdir(tmp)).find((name) => name.includes(".lock.claim-"));
      expect(claimName).toBeDefined();
      expect(await readdir(path.join(tmp, claimName!))).toEqual([expect.stringMatching(/^held-[A-Za-z0-9_-]{21}$/)]);

      second = await acquireOutputGroupLock(group);
      resume();
      await expect(firstPromise).rejects.toMatchObject({ code: "output.busy" });
    } finally {
      resume();
      await (await firstSettled)?.release();
      await second?.release();
    }
    expect(existsSync(lockPath)).toBe(false);
  });

  it("removes its partial marker and claim after a marker write fails, preserving the setup error", async () => {
    const failure = Object.assign(new Error("partial marker write"), { code: "ENOSPC" });
    markerWriteFailure.error = failure;
    const group = createOutputGroup(tmp, "failed", "png");

    await expect(acquireOutputGroupLock(group)).rejects.toMatchObject({ code: "output.lockFailed", cause: failure });
    expect(await readdir(tmp)).toEqual([]);
    expect(markerWriteFailure.endpoint).toBeDefined();
    if (process.platform !== "win32") expect(existsSync(markerWriteFailure.endpoint!)).toBe(false);
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
