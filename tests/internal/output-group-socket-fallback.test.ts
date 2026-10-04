import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireOutputGroupLock,
  createOutputGroup,
  guardianEndpointFor,
  outputGroupLockPathFor,
} from "../../src/internal/output-group.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const OUTPUT_GROUP_MODULE = pathToFileURL(path.join(REPO_ROOT, "src/internal/output-group.ts")).href;
const CHILD_PROCESS_TIMEOUT_MS = 3_000;
const TEST_TIMEOUT_MS = CHILD_PROCESS_TIMEOUT_MS * 4;
// macOS rejects a Unix socket path longer than this many bytes.
const DARWIN_SOCKET_PATH_LIMIT = 104;
const HELD_MARKER = /^held-([A-Za-z0-9_-]{21})$/;

function spawnNode(script: string, tmpdirValue: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: REPO_ROOT,
    env: { ...process.env, TMPDIR: tmpdirValue },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function firstLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`child produced no line: ${stderr}`)), CHILD_PROCESS_TIMEOUT_MS);
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const end = stdout.indexOf("\n");
      if (end === -1) return;
      clearTimeout(timeout);
      resolve(stdout.slice(0, end));
    });
    child.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("child did not exit")), CHILD_PROCESS_TIMEOUT_MS);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

describe.skipIf(process.platform !== "darwin")(
  "output reservation guardian under a TMPDIR too long for a socket path (macOS only: CI does not run macOS)",
  () => {
    const originalTmpdirEnv = process.env.TMPDIR;
    let shortTmp: string;
    let longTmp: string;
    let outDir: string;
    // A killed holder's socket stays in /tmp; a failing test must not leave it.
    let killedEndpoint: string | undefined;

    // A contender in another process, with its own TMPDIR, reports what an
    // acquire attempt on the shared stem did.
    function contenderScript(stem: string): string {
      return `
        import { acquireOutputGroupLock, createOutputGroup } from ${JSON.stringify(OUTPUT_GROUP_MODULE)};
        try {
          const lock = await acquireOutputGroupLock(createOutputGroup(${JSON.stringify(outDir)}, ${JSON.stringify(stem)}, "png"));
          await lock.release();
          process.stdout.write("acquired\\n");
        } catch (err) {
          process.stdout.write(String(err.code) + "\\n");
        }
      `;
    }

    async function contend(stem: string, tmpdirValue: string): Promise<string> {
      const child = spawnNode(contenderScript(stem), tmpdirValue);
      const line = await firstLine(child);
      await waitForExit(child);
      return line;
    }

    async function guardianOf(stem: string): Promise<{ socketDir: string; endpoint: string }> {
      const lockPath = await outputGroupLockPathFor(createOutputGroup(outDir, stem, "png"));
      const held = (await readdir(lockPath)).find((name) => HELD_MARKER.test(name));
      expect(held).toBeDefined();
      const token = HELD_MARKER.exec(held!)![1]!;
      const socketDir = await readFile(path.join(lockPath, held!), "utf-8");
      return { socketDir, endpoint: guardianEndpointFor(lockPath, token, socketDir) };
    }

    beforeEach(async () => {
      shortTmp = tmpdir();
      const base = await mkdtemp(path.join(shortTmp, "gptimg-long-tmpdir-"));
      longTmp = path.join(base, "x".repeat(60));
      await mkdir(longTmp);
      outDir = await mkdtemp(path.join(shortTmp, "gptimg-group-socket-"));
      process.env.TMPDIR = longTmp;
      killedEndpoint = undefined;
      // The preferred socket path must be one macOS could not even bind.
      expect(Buffer.byteLength(path.join(tmpdir(), "gi-000000000000000000000000.sock"))).toBeGreaterThan(
        DARWIN_SOCKET_PATH_LIMIT,
      );
    });

    afterEach(async () => {
      if (originalTmpdirEnv === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdirEnv;
      if (killedEndpoint) await unlink(killedEndpoint).catch(() => undefined);
      await rm(path.dirname(longTmp), { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    });

    it(
      "listens in /tmp, excludes contenders from either TMPDIR, and releases cleanly",
      async () => {
        const group = createOutputGroup(outDir, "shared", "png");
        const lock = await acquireOutputGroupLock(group);
        let released = false;
        try {
          await expect(acquireOutputGroupLock(group)).rejects.toMatchObject({ code: "output.busy" });
          expect(await contend("shared", longTmp)).toBe("output.busy");
          expect(await contend("shared", shortTmp)).toBe("output.busy");

          const { socketDir, endpoint } = await guardianOf("shared");
          expect(socketDir).toBe("/tmp");
          expect(path.dirname(endpoint)).toBe("/tmp");
          expect((await lstat(endpoint)).isSocket()).toBe(true);
          expect((await readdir(longTmp)).filter((name) => name.endsWith(".sock"))).toEqual([]);

          await lock.release();
          released = true;
          expect(existsSync(endpoint)).toBe(false);
          expect(existsSync(await outputGroupLockPathFor(group))).toBe(false);
        } finally {
          if (!released) await lock.release();
        }
        expect(await contend("shared", shortTmp)).toBe("acquired");
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "reclaims a killed holder's lock from another TMPDIR and removes its stale /tmp socket",
      async () => {
        const holder = spawnNode(
          `
            import { acquireOutputGroupLock, createOutputGroup } from ${JSON.stringify(OUTPUT_GROUP_MODULE)};
            await acquireOutputGroupLock(createOutputGroup(${JSON.stringify(outDir)}, "crashed", "png"));
            process.stdout.write("ready\\n");
            process.stdin.resume();
          `,
          longTmp,
        );
        let endpoint = "";
        try {
          expect(await firstLine(holder)).toBe("ready");
          ({ endpoint } = await guardianOf("crashed"));
          killedEndpoint = endpoint;
          expect(path.dirname(endpoint)).toBe("/tmp");
          expect((await lstat(endpoint)).isSocket()).toBe(true);
          expect(await contend("crashed", shortTmp)).toBe("output.busy");
        } finally {
          holder.kill("SIGKILL");
          await waitForExit(holder);
        }
        // SIGKILL closes the listener but leaves its socket file behind.
        expect(existsSync(endpoint)).toBe(true);

        expect(await contend("crashed", shortTmp)).toBe("acquired");
        expect(existsSync(endpoint)).toBe(false);
        expect(existsSync(await outputGroupLockPathFor(createOutputGroup(outDir, "crashed", "png")))).toBe(false);
      },
      TEST_TIMEOUT_MS,
    );
  },
);
