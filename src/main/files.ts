// Writing a file whole: stage beside it under an exclusive name, then rename
// over it, so a reader never sees half a file (content-lifecycle-conventions).
import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
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
export async function writeTextAtomic(path: string, text: string, mode = 0o644): Promise<boolean> {
  const current = await readText(path);
  if (current.kind === "ok" && current.text === text) return false;
  const temp = stagingName(path);
  try {
    await writeFile(temp, text, { encoding: "utf8", flag: "wx", mode });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return true;
}

export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
