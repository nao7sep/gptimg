import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireOutputGroupLock, createOutputGroup } from "../../src/internal/output-group.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const OUTPUT_GROUP_MODULE = pathToFileURL(path.join(REPO_ROOT, "src/internal/output-group.ts")).href;
const CHILD_PROCESS_TIMEOUT_MS = 3_000;
const TEST_TIMEOUT_MS = CHILD_PROCESS_TIMEOUT_MS * 3;

const children = new Map<ChildProcessWithoutNullStreams, Promise<number | null>>();

function spawnOwned(script: string, tsx = false): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [
    ...(tsx ? ["--import", "tsx"] : []), "--input-type=module", "--eval", script,
  ], { cwd: REPO_ROOT, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  void closed.catch(() => undefined);
  children.set(child, closed);
  return child;
}

async function waitForReady(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stderr = "";
    const finish = (error: Error | null, ready = ""): void => {
      clearTimeout(timeout);
      child.stdout.off("data", onReady);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("close", onClose);
      if (error) reject(error); else resolve(ready);
    };
    const onReady = (chunk: string): void => finish(null, chunk);
    const onStderr = (chunk: string): void => { stderr += chunk; };
    const onError = (error: Error): void => finish(error);
    const onClose = (): void => finish(new Error(`child exited before reservation: ${stderr}`));
    const timeout = setTimeout(() => finish(new Error(`child reservation timed out: ${stderr}`)), CHILD_PROCESS_TIMEOUT_MS);
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", onStderr);
    child.stdout.setEncoding("utf-8");
    child.stdout.once("data", onReady);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs = CHILD_PROCESS_TIMEOUT_MS): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      children.get(child)!,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("child reservation did not exit")), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

async function stopChild(child: ChildProcessWithoutNullStreams, graceMs = CHILD_PROCESS_TIMEOUT_MS): Promise<number | null> {
  try {
    child.stdin.end();
    try {
      return await waitForExit(child, graceMs);
    } catch (error) {
      child.kill("SIGKILL");
      await waitForExit(child);
      throw error;
    }
  } finally {
    if (child.exitCode !== null || child.signalCode !== null) children.delete(child);
  }
}

describe("cross-process output reservations", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-group-process-"));
  });

  afterEach(async () => {
    for (const child of children.keys()) {
      child.kill("SIGKILL");
      await waitForExit(child);
      children.delete(child);
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it("rejects a live owner through a lexical stem alias and recovers after its process exits", async () => {
    const childScript = `
      import { acquireOutputGroupLock, createOutputGroup } from ${JSON.stringify(OUTPUT_GROUP_MODULE)};
      await acquireOutputGroupLock(createOutputGroup(${JSON.stringify(tmp)}, "nested/../shared", "png"));
      process.stdout.write("ready\\n");
      process.stdin.resume();
      await new Promise((resolve) => process.stdin.once("end", resolve));
    `;
    const child = spawnOwned(childScript, true);
    const group = createOutputGroup(tmp, "shared", "jpg");
    let exitCode: number | null;
    try {
      expect(await waitForReady(child)).toContain("ready");
      await expect(acquireOutputGroupLock(group)).rejects.toMatchObject({ code: "output.busy" });
    } finally {
      exitCode = await stopChild(child);
    }
    expect(exitCode).toBe(0);
    const recovered = await acquireOutputGroupLock(group);
    await recovered.release();
  }, TEST_TIMEOUT_MS);

  it("reaps a child that exits before setup is ready", async () => {
    const child = spawnOwned('process.stderr.write("setup failed"); process.exit(1);');
    await expect(waitForReady(child)).rejects.toThrow("setup failed");
    expect(await stopChild(child)).toBe(1);
    expect(children.has(child)).toBe(false);
  }, TEST_TIMEOUT_MS);

  it("kills and reaps a child that ignores graceful release", async () => {
    const child = spawnOwned('process.stdin.resume(); setInterval(() => {}, 60_000); process.stdout.write("ready");');
    expect(await waitForReady(child)).toBe("ready");
    await expect(stopChild(child, 20)).rejects.toThrow("did not exit");
    expect(child.signalCode).toBe("SIGKILL");
    expect(children.has(child)).toBe(false);
  }, TEST_TIMEOUT_MS);

});
