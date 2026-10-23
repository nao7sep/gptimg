import { chmod, link, lstat, open, readFile, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";

export interface AtomicWriteOptions {
  /** Replace an existing target; without it an existing target fails EEXIST. */
  overwrite: boolean;
}

/**
 * The house atomic-write mechanism, per the storage-path-conventions, *Atomic
 * writes*: a same-directory `<stem>-<discriminator>.tmp` temp file,
 * written, flushed to disk and then atomically published by rename or hard link. Same-directory
 * placement is load-bearing — both operations stay on one filesystem, so
 * staging anywhere else (a central temp dir) could degrade to a non-atomic
 * cross-volume copy for a relocated target. The `nanoid()` discriminator is
 * enough to keep two concurrent writers of the same target from sharing a temp
 * file.
 */
export function stagingPathFor(filePath: string): string {
  const dir = path.dirname(filePath);
  const stem = path.parse(filePath).name;
  const discriminator = nanoid();
  return path.join(dir, `${stem}-${discriminator}.tmp`);
}

// A publication owns its target until the filesystem work settles. This also
// covers local writers, which do not hold a paid output-group reservation.
const publishingTargets = new Set<string>();

function targetExists(filePath: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`EEXIST: file already exists, publish '${filePath}'`), { code: "EEXIST", syscall: "rename", path: filePath });
}

const HARD_LINK_UNAVAILABLE = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);

/**
 * Publish without replacing an existing target. A hard link claims the name
 * atomically, failing EEXIST when it is taken. A volume without hard links
 * (exFAT, FAT32) gets the staged file renamed in once the name is confirmed
 * free (storage-path-conventions, *Replacement and publication*): no reader
 * sees a partial file. A process-local target claim excludes SDK competitors;
 * the remaining gap is an external writer or separate process taking the name
 * between the check and the rename. Never a copy into place, which would expose
 * a partial file. Returns whether the staged name is still there to remove.
 */
export async function publishFileNoClobber(tempPath: string, filePath: string, createLink: typeof link = link): Promise<{ tempRemains: boolean }> {
  const directory = await realpath(path.dirname(filePath));
  const name = path.basename(filePath).normalize("NFC").toLowerCase();
  const target = path.join(directory, name);
  // Check and claim synchronously after the last await, including portable
  // filename aliases even on a case-sensitive volume.
  if (publishingTargets.has(target)) throw targetExists(filePath);
  publishingTargets.add(target);
  try {
    // Preflight may have run before an earlier SDK publisher settled. Inspect
    // disk under the claim as well, so portable aliases cannot publish later
    // as distinct entries on a case-sensitive or normalization-sensitive volume.
    if ((await readdir(directory)).some((entry) => entry.normalize("NFC").toLowerCase() === name)) {
      throw targetExists(filePath);
    }
    try {
      await createLink(tempPath, filePath);
      return { tempRemains: true };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !HARD_LINK_UNAVAILABLE.has(code)) throw err;
    }
    if (await nameTaken(filePath)) throw targetExists(filePath);
    await rename(tempPath, filePath);
    return { tempRemains: false };
  } finally {
    publishingTargets.delete(target);
  }
}

async function nameTaken(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** Write `bytes` to a new file and flush them to disk, so a published name never points at lost data after a crash. */
async function writeSynced(filePath: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(filePath, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Flush a folder's entries, so a file just renamed or linked into it survives
 * a crash. Windows cannot open a folder for this, and its file system commits
 * the rename itself.
 */
export async function syncDirectory(dirPath: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(dirPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function cleanupPublishedTemp(tempPath: string, removeTemp: typeof unlink = unlink): Promise<void> {
  await removeTemp(tempPath).catch(() => undefined);
}

/** Whether `filePath` already holds exactly `bytes`; an unreadable target does not. */
async function holdsContent(filePath: string, bytes: Uint8Array): Promise<boolean> {
  try {
    return (await readFile(filePath)).equals(bytes);
  } catch {
    return false;
  }
}

/**
 * The permission mode a replacement should carry over from the file it
 * replaces: none when the target is absent, or on Windows, whose mode holds only a read-only bit that already blocks the
 * replace. Node cannot copy extended attributes, so the mode is what a replace
 * keeps (content-lifecycle-conventions, *Files*).
 */
async function replacedMode(filePath: string): Promise<number | undefined> {
  if (process.platform === "win32") return undefined;
  try {
    return (await stat(filePath)).mode & 0o7777;
  } catch {
    return undefined;
  }
}

/**
 * Write `data` to `filePath` atomically: stage it at a temp path beside the
 * target (see `stagingPathFor`), then publish it so a crash mid-write can never
 * leave `filePath` truncated or torn. `overwrite: false` publishes without
 * replacing an existing target (see `publishFileNoClobber`). The content is
 * flushed before publication and the folder after it, so a crash cannot leave
 * the name pointing at nothing. On any failure before publication the temp
 * file is best-effort removed and the target is left untouched; a failure to
 * flush the folder afterwards is thrown, the file already published.
 *
 * An overwrite whose content is identical to the target's is skipped, so the
 * file and its times stay as they are (content-lifecycle-conventions, *Files*).
 * A changed overwrite keeps the replaced file's permission mode. A string is
 * written as UTF-8.
 *
 * Storage waits are unbounded by design (sdk-conventions, *Waits are bounded
 * where a stall is realistic*): gptimgsdk's storage is local, and Node cannot
 * cancel a filesystem call already running, so a timer would only stop waiting
 * while the call kept its thread and its write might still land.
 */
export async function writeFileAtomic(filePath: string, data: string | Buffer | Uint8Array, { overwrite }: AtomicWriteOptions): Promise<void> {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  if (overwrite && (await holdsContent(filePath, bytes))) return;
  const tempPath = await stageFile(filePath, bytes);
  await publishStaged(tempPath, filePath, { overwrite });
  await syncDirectory(path.dirname(filePath));
}

/**
 * Write `bytes` beside `filePath` under a staging name, flushed to disk, and
 * return that name; nothing is visible at `filePath` yet. A failure removes
 * the staged file. With `publishStaged`, a caller that publishes several files
 * together stages them all first, so a failure to write any leaves every
 * target as it was.
 */
export async function stageFile(filePath: string, bytes: Uint8Array): Promise<string> {
  const tempPath = stagingPathFor(filePath);
  try {
    await writeSynced(tempPath, bytes);
  } catch (err) {
    await unlink(tempPath).catch(() => undefined);
    throw err;
  }
  return tempPath;
}

/**
 * Publish a staged file at `filePath`: replacing it, keeping the replaced
 * file's permission mode, or, without `overwrite`, only when the name is free.
 * A failure removes the staged file and leaves the target as it was. The
 * caller flushes the folder once its files are in.
 */
export async function publishStaged(tempPath: string, filePath: string, { overwrite }: AtomicWriteOptions): Promise<void> {
  let tempRemains = false;
  try {
    if (overwrite) {
      const mode = await replacedMode(filePath);
      if (mode !== undefined) await chmod(tempPath, mode);
      await rename(tempPath, filePath);
    } else {
      ({ tempRemains } = await publishFileNoClobber(tempPath, filePath));
    }
  } catch (err) {
    await unlink(tempPath).catch(() => undefined);
    throw err;
  }
  // Publication is the commit point. A cleanup failure must not turn a
  // successfully published target into a reported failure (and, for callers
  // that publish an image before its sidecar, an apparently orphaned group).
  if (tempRemains) await cleanupPublishedTemp(tempPath);
}
