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

async function waitForReady(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`child reservation timed out: ${stderr}`)), 3_000);
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf-8");
    child.stdout.once("data", (chunk: string) => {
      clearTimeout(timeout);
      resolve(chunk);
    });
    child.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("child reservation did not exit")), 3_000);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
    child.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe("cross-process output reservations", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-group-process-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("rejects a live owner and recovers after that process exits without release", async () => {
    const childScript = `
      import { acquireOutputGroupLock, createOutputGroup } from ${JSON.stringify(OUTPUT_GROUP_MODULE)};
      await acquireOutputGroupLock(createOutputGroup(${JSON.stringify(tmp)}, "shared", "png"));
      process.stdout.write("ready\\n");
      process.stdin.resume();
      await new Promise((resolve) => process.stdin.once("end", resolve));
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childScript], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exitPromise = waitForExit(child);
    const group = createOutputGroup(tmp, "shared", "jpg");
    try {
      expect(await waitForReady(child)).toContain("ready");
      await expect(acquireOutputGroupLock(group)).rejects.toMatchObject({ code: "output.busy" });
    } finally {
      child.stdin.end();
    }
    expect(await exitPromise).toBe(0);
    const recovered = await acquireOutputGroupLock(group);
    await recovered.release();
  });
});
