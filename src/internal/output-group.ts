import { readdirSync } from "node:fs";
import { mkdir, readdir, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { nanoid } from "nanoid";
import { LocalOpError } from "../errors.js";
import { indexSuffix } from "./output-naming.js";

/**
 * The artifact group produced by a single `generate` or `edit` invocation:
 * a stem plus an image extension plus a sidecar extension, with one sidecar
 * per image (the per-image sidecar contract — no shared sidecar for n>1).
 * Membership is defined purely by filename pattern in `dir`:
 *
 *   - `<stem>.<ext>`                  — single output (n=1)
 *   - `<stem>-<digits>.<ext>`         — indexed multi-output (any width)
 *   - `<stem>.<sidecarExt>`           — single sidecar (n=1)
 *   - `<stem>-<digits>.<sidecarExt>`  — per-image sidecar (n>1)
 *
 * Mask/compose/combine derived siblings (`-mask`, `-cutout`, etc.) are NOT
 * group members; they belong to other verbs' output and must not be touched
 * by generate/edit overwrite logic.
 */
export interface OutputGroup {
  dir: string;
  stem: string;
  ext: string;
  sidecarExt: string;
}

export function outputGroupLockPathFor(group: OutputGroup): string {
  const identity = path.resolve(group.dir, group.stem).toLowerCase();
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return path.join(group.dir, `.gptimg-output-${digest}.lock`);
}

const LOCK_INITIALIZATION_GRACE_MS = 5_000;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function recoverReleasedOrDeadLock(lockPath: string): Promise<boolean> {
  let initialIdentity: { dev: number; ino: number; birthtimeMs: number };
  try {
    const initial = await stat(lockPath);
    initialIdentity = {
      dev: initial.dev,
      ino: initial.ino,
      birthtimeMs: initial.birthtimeMs,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
  let entries: string[];
  try {
    entries = await readdir(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }

  const released = entries.some((name) => name.startsWith("released-"));
  const held = entries.find((name) => name.startsWith("held-"));
  const pid = held ? Number(/^held-(\d+)-/.exec(held)?.[1]) : Number.NaN;
  let recoverable = released || (Number.isInteger(pid) && !processIsAlive(pid));

  if (!recoverable && entries.length === 0) {
    try {
      const ageMs = Date.now() - (await stat(lockPath)).mtimeMs;
      recoverable = ageMs >= LOCK_INITIALIZATION_GRACE_MS;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    }
  }
  if (!recoverable) return false;

  let removedObservedEntry = entries.length === 0;
  for (const name of entries) {
    try {
      await unlink(path.join(lockPath, name));
      removedObservedEntry = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
  }
  // Only the contender that removed an observed marker may remove the
  // directory. This avoids an ABA race where a second stale-lock contender
  // deletes a newly acquired lock after the first one recovered the old lock.
  if (!removedObservedEntry) return true;
  try {
    const current = await stat(lockPath);
    if (current.dev !== initialIdentity.dev || current.ino !== initialIdentity.ino || current.birthtimeMs !== initialIdentity.birthtimeMs) {
      return true;
    }
    await rmdir(lockPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
      return false;
    }
  }
  return true;
}

export interface OutputGroupLock extends AsyncDisposable {
  release(): Promise<void>;
}

/**
 * Reserve one output stem across processes. The directory is the atomic lock;
 * its owner marker carries a PID so a crashed process is recoverable. Release
 * first marks ownership as released, so even a failed cleanup cannot brick the
 * stem while the process remains alive.
 */
export async function acquireOutputGroupLock(group: OutputGroup): Promise<OutputGroupLock> {
  const lockPath = outputGroupLockPathFor(group);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await mkdir(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new LocalOpError(
          "output.lockFailed",
          `Failed to reserve output stem ${JSON.stringify(group.stem)}: ${(err as Error).message}`,
          { cause: err },
        );
      }
      if (await recoverReleasedOrDeadLock(lockPath)) continue;
      throw new LocalOpError("output.busy", `Another operation is publishing output stem ${JSON.stringify(group.stem)}. Try again.`, {
        cause: err,
      });
    }

    const token = nanoid();
    const ownerPath = path.join(lockPath, `held-${process.pid}-${token}`);
    try {
      await writeFile(ownerPath, "", { flag: "wx" });
    } catch (err) {
      await rmdir(lockPath).catch(() => undefined);
      throw new LocalOpError(
        "output.lockFailed",
        `Failed to identify output reservation ${JSON.stringify(group.stem)}: ${(err as Error).message}`,
        { cause: err },
      );
    }

    let didRelease = false;
    const release = async (): Promise<void> => {
      if (didRelease) return;
      didRelease = true;
      const releasedPath = path.join(lockPath, `released-${process.pid}-${token}`);
      try {
        await rename(ownerPath, releasedPath);
      } catch {
        // If the state transition itself fails, a separate released marker
        // still makes a later acquisition recoverable in this live process.
        await writeFile(releasedPath, "", { flag: "wx" }).catch(() => undefined);
      }
      await unlink(ownerPath).catch(() => undefined);
      await unlink(releasedPath).catch(() => undefined);
      await rmdir(lockPath).catch(() => undefined);
    };
    return { release, [Symbol.asyncDispose]: release };
  }
  throw new LocalOpError("output.busy", `Output stem ${JSON.stringify(group.stem)} changed ownership while being recovered. Try again.`);
}

/** Serialize work for one output stem and always release its reservation. */
export async function withOutputGroupLock<T>(group: OutputGroup, body: () => Promise<T>): Promise<T> {
  const lock = await acquireOutputGroupLock(group);
  try {
    return await body();
  } finally {
    await lock.release();
  }
}

/** Start every publisher, wait for all of them, then report failures in plan order. */
export async function settleOutputPublications(publishers: ReadonlyArray<() => Promise<void>>): Promise<void> {
  const settled = await Promise.allSettled(publishers.map((publish) => Promise.resolve().then(publish)));
  const failures = settled.flatMap((result, index) => (result.status === "rejected" ? [{ index: index + 1, reason: result.reason }] : []));
  if (failures.length === 0) return;
  const details = failures
    .map(({ index, reason }) => `item ${index}: ${reason instanceof Error ? reason.message : String(reason)}`)
    .join("; ");
  throw new LocalOpError("output.publicationFailed", `Failed to publish ${failures.length} output item(s): ${details}`, {
    cause: new AggregateError(failures.map(({ reason }) => reason)),
  });
}

const SIDECAR_EXT = "json";

export function createOutputGroup(dir: string, stem: string, ext: string): OutputGroup {
  return { dir, stem, ext, sidecarExt: SIDECAR_EXT };
}

/**
 * The sidecar path for the image at `index` in a group of `suffixWidth`.
 * For n=1 this returns `<stem>.<sidecarExt>`; for n>1 it returns
 * `<stem>-<index>.<sidecarExt>` matching the image's index suffix.
 */
export function sidecarPathFor(group: OutputGroup, index: number, suffixWidth: number): string {
  return path.join(group.dir, `${group.stem}${indexSuffix(index, suffixWidth)}.${group.sidecarExt}`);
}

export function plannedSidecarPaths(group: OutputGroup, count: number, suffixWidth: number): string[] {
  const paths: string[] = [];
  for (let i = 1; i <= count; i++) {
    paths.push(sidecarPathFor(group, i, suffixWidth));
  }
  return paths;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function siblingsOnDisk(group: OutputGroup): string[] {
  let entries: string[];
  try {
    entries = readdirSync(group.dir);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return [];
    throw new LocalOpError("output.scanFailed", `Failed to scan output directory ${group.dir}: ${e.message}`, {
      cause: err,
    });
  }
  const stem = escapeRegex(group.stem);
  const ext = escapeRegex(group.ext);
  const sx = escapeRegex(group.sidecarExt);
  // Case-insensitive: on macOS/Windows a `photo`-stem output collides with a
  // `Photo`-stem group, so it must be detected as a sibling regardless of case.
  const imagePattern = new RegExp(`^${stem}(?:-\\d+)?\\.${ext}$`, "i");
  const sidecarPattern = new RegExp(`^${stem}(?:-\\d+)?\\.${sx}$`, "i");
  return entries
    .filter((name) => imagePattern.test(name) || sidecarPattern.test(name))
    .map((name) => path.join(group.dir, name))
    .sort();
}

/**
 * Group-scoped output assertion.
 *
 * - Without `allowOverwrite`: any existing group sibling blocks. This is
 *   stricter than the previous plan-scoped check by design — a stem that
 *   carries any prior-run artifact is not safe to write into without an
 *   explicit overwrite intent.
 *
 * - With `allowOverwrite`: planned files may exist (they will be replaced).
 *   Group siblings that are NOT in the planned set are reported as
 *   `output.staleSiblings`. The user resolves it by deleting them or
 *   choosing a fresh name. This is the halt the playbook prefers over a
 *   silent cleanup subsystem.
 */
export function assertOutputGroupAvailable(group: OutputGroup, plannedFiles: string[], allowOverwrite: boolean): void {
  const plannedResolved = new Set<string>();
  for (const p of plannedFiles) {
    const r = path.resolve(p);
    if (plannedResolved.has(r)) {
      throw new LocalOpError("output.duplicate", `Multiple planned outputs resolve to the same path: ${p}`);
    }
    plannedResolved.add(r);
  }

  const existing = siblingsOnDisk(group);
  if (existing.length === 0) return;

  if (!allowOverwrite) {
    throw new LocalOpError("output.exists", `Output exists: ${existing[0]}. Use overwrite to allow.`);
  }
  const stale = existing.filter((p) => !plannedResolved.has(path.resolve(p)));
  if (stale.length > 0) {
    const names = stale.map((p) => path.basename(p)).join(", ");
    throw new LocalOpError(
      "output.staleSiblings",
      `Refusing to overwrite: the artifact group "${group.stem}.${group.ext}" in ${group.dir} ` +
        `has ${stale.length} file(s) from a prior run that this run will not replace: ${names}. ` +
        `Delete them or choose a fresh outName.`,
    );
  }
}

/**
 * Fail-fast availability pre-check, usable BEFORE the image format is known.
 * The per-image sidecars (.json) are the extension-independent identity of an
 * output group, so checking them lets generate/edit reject a conflicting stem
 * before spending on a provider call. The full image+sidecar check
 * (assertOutputGroupAvailable) still runs after the response as the authority.
 */
export function assertStemAvailable(dir: string, stem: string, count: number, allowOverwrite: boolean): void {
  const sidecarGroup = createOutputGroup(dir, stem, SIDECAR_EXT);
  assertOutputGroupAvailable(sidecarGroup, plannedSidecarPaths(sidecarGroup, count, count), allowOverwrite);
}
