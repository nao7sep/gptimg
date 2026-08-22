import { constants } from "node:fs";
import { copyFile, link, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";

export interface AtomicWriteOptions {
  /** Text encoding, applied only when `data` is a string. */
  encoding?: BufferEncoding;
  /** POSIX file mode to create the file with (e.g. 0o600 for a secrets file). */
  mode?: number;
  /** Replace an existing target. Defaults to true for backwards compatibility. */
  overwrite?: boolean;
}

/**
 * The house atomic-write mechanism, per the storage-path convention's *Atomic
 * writes* section: a same-directory `<stem>-<discriminator>.tmp` temp file,
 * written and then atomically published by rename or hard link. Same-directory
 * placement is load-bearing — both operations stay on one filesystem, so
 * staging anywhere else (a central temp dir) could degrade to a non-atomic
 * cross-volume copy for a relocated target. The discriminator is the fleet's
 * established `nanoid()` (also used for staged model downloads in
 * `local/models/fetch.ts`), which is enough to keep two concurrent writers of
 * the same target from sharing a temp file.
 */
export function stagingPathFor(filePath: string): string {
  const dir = path.dirname(filePath);
  const stem = path.parse(filePath).name;
  const discriminator = nanoid();
  return path.join(dir, `${stem}-${discriminator}.tmp`);
}

const HARD_LINK_UNAVAILABLE = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);

/**
 * Publish without replacing an existing target. Hard links give local
 * filesystems an atomic namespace commit; filesystems without hard-link support
 * fall back to COPYFILE_EXCL, which preserves the no-clobber guarantee in one
 * filesystem operation rather than reintroducing a check/write race.
 */
export async function publishFileNoClobber(tempPath: string, filePath: string, createLink: typeof link = link): Promise<void> {
  try {
    await createLink(tempPath, filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!code || !HARD_LINK_UNAVAILABLE.has(code)) throw err;
    await copyFile(tempPath, filePath, constants.COPYFILE_EXCL);
  }
}

export async function cleanupPublishedTemp(tempPath: string, removeTemp: typeof unlink = unlink): Promise<void> {
  await removeTemp(tempPath).catch(() => undefined);
}

/**
 * Write `data` to `filePath` atomically: stage it at a temp path beside the
 * target (see `stagingPathFor`), then publish it so a crash mid-write can never
 * leave `filePath` truncated or torn. `overwrite: false` uses an atomic hard
 * link to reject an existing target without a check/write race. On any failure
 * the temp file is best-effort removed and the target is left untouched.
 */
export async function writeFileAtomic(filePath: string, data: string | Buffer | Uint8Array, options?: AtomicWriteOptions): Promise<void> {
  const tempPath = stagingPathFor(filePath);
  try {
    const { overwrite = true, ...writeOptions } = options ?? {};
    await writeFile(tempPath, data, writeOptions);
    if (overwrite) {
      await rename(tempPath, filePath);
    } else {
      await publishFileNoClobber(tempPath, filePath);
    }
  } catch (err) {
    await unlink(tempPath).catch(() => undefined);
    throw err;
  }
  // Publication is the commit point. A cleanup failure must not turn a
  // successfully published target into a reported failure (and, for callers
  // that publish an image before its sidecar, an apparently orphaned group).
  await cleanupPublishedTemp(tempPath);
}
