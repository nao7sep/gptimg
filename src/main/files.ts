// Writing a file whole: stage beside it under an exclusive name, then rename
// over it, so a reader never sees half a file (content-lifecycle-conventions).
import { randomBytes } from "node:crypto";
import { copyFile, open, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type ReadResult = { kind: "absent" } | { kind: "ok"; text: string } | { kind: "failed"; error: unknown };

/** Reads text, telling absence apart from a failed read: only absence is permission to start fresh. */
export async function readText(path: string): Promise<ReadResult> {
  try {
    return { kind: "ok", text: await readFile(path, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "failed", error };
  }
}

/** `<stem>-<id>.tmp` beside the target. */
export function stagingName(target: string): string {
  const stem = basename(target).replace(/\.[^.]*$/, "");
  return join(dirname(target), `${stem}-${randomBytes(6).toString("hex")}.tmp`);
}

/**
 * Replaces a file with new text. Identical content is not written again, so
 * the file's time, backups and sync see only real changes. Returns whether
 * anything was written.
 */
export async function writeTextAtomic(path: string, text: string, mode?: number): Promise<boolean> {
  const current = await readText(path);
  if (current.kind === "ok" && current.text === text) return false;
  if (current.kind === "failed") throw current.error;
  const finalMode = mode ?? (current.kind === "ok" && process.platform !== "win32" ? (await stat(path)).mode & 0o7777 : 0o644);
  const temp = stagingName(path);
  let owned = false;
  try {
    const handle = await open(temp, "wx", 0o600);
    owned = true;
    try {
      await handle.writeFile(text, "utf8");
      await handle.chmod(finalMode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
    owned = false;
  } finally {
    if (owned) await rm(temp, { force: true }).catch(() => {});
  }
  return true;
}

export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Copy complete, flushed bytes into place, keeping the source's modification time. */
export async function copyFileAtomic(source: string, target: string): Promise<void> {
  const times = await stat(source);
  const temp = stagingName(target);
  let owned = false;
  try {
    const claim = await open(temp, "wx", 0o600);
    owned = true;
    await claim.close();
    await copyFile(source, temp);
    await utimes(temp, times.atime, times.mtime);
    const handle = await open(temp, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
    owned = false;
  } finally {
    if (owned) await rm(temp, { force: true }).catch(() => {});
  }
}
