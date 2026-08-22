import { readdirSync } from "node:fs";
import { mkdir, readdir, realpath, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import { LocalOpError } from "../errors.js";
import { SUPPORTED_IMAGE_EXTENSIONS } from "../image/detectFormat.js";
import { indexSuffix } from "./output-naming.js";

/**
 * The artifact group produced by a single `generate` or `edit` invocation:
 * a stem plus any supported emitted image extension plus a sidecar extension,
 * with one sidecar per image (the per-image sidecar contract — no shared
 * sidecar for n>1). This makes format changes one coherent overwrite group.
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

const TARGET_MARKER = ".gptimg-target";

function normalizedOutputGroup(group: OutputGroup): OutputGroup {
  // Append a marker before resolving so even unusual stems such as `.` and an
  // empty string retain the same filename semantics as `<stem>.<extension>`.
  // path.join mirrors the publication path, while path.resolve collapses `.`
  // and `..` aliases before any lock or sibling decision is made.
  const target = path.resolve(path.join(group.dir, `${group.stem}${TARGET_MARKER}`));
  const markedName = path.basename(target);
  return {
    ...group,
    dir: path.dirname(target),
    stem: markedName.slice(0, -TARGET_MARKER.length),
  };
}

export async function outputGroupLockPathFor(group: OutputGroup): Promise<string> {
  const normalized = normalizedOutputGroup(group);
  const canonicalDir = await realpath(normalized.dir);
  const directory = await stat(canonicalDir);
  const identity = `${canonicalDir}\0${directory.dev}:${directory.ino}\0${normalized.stem.normalize("NFC").toLowerCase()}`;
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return path.join(canonicalDir, `.gptimg-output-${digest}.lock`);
}

const HELD_MARKER = /^held-([A-Za-z0-9_-]{21})$/;
const GUARDIAN_PROBE_TIMEOUT_MS = 1_000;

function guardianEndpointFor(lockPath: string, token: string): string {
  const digest = createHash("sha256").update(`${lockPath}\0${token}`).digest("hex").slice(0, 24);
  if (process.platform === "win32") return `\\\\.\\pipe\\gptimg-output-${digest}`;
  const socketName = `gi-${digest}.sock`;
  const preferred = path.join(tmpdir(), socketName);
  return Buffer.byteLength(preferred) <= 90 ? preferred : path.join("/tmp", socketName);
}

async function startGuardian(endpoint: string): Promise<Server> {
  const server = createServer((socket) => socket.destroy());
  server.unref();
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
  // A later server error must never escape to stderr from the SDK. Losing the
  // endpoint makes the reservation recoverable, while the current call still
  // retains create-if-absent publication as its final no-clobber boundary.
  server.on("error", () => undefined);
  return server;
}

async function closeGuardian(server: Server, endpoint: string): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
  if (process.platform !== "win32") await unlink(endpoint).catch(() => undefined);
}

async function guardianIsAlive(endpoint: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection(endpoint);
    let settled = false;
    const finish = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(alive);
    };
    const timeout = setTimeout(() => finish(true), GUARDIAN_PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("error", (err: NodeJS.ErrnoException) => {
      finish(!["ECONNREFUSED", "ENOENT", "ENXIO"].includes(err.code ?? ""));
    });
  });
}

interface PreparedLockClaim {
  claimPath: string;
  endpoint: string;
  markerName: string;
  server: Server;
}

async function prepareLockClaim(lockPath: string): Promise<PreparedLockClaim> {
  const token = nanoid();
  const markerName = `held-${token}`;
  const claimPath = `${lockPath}.claim-${token}`;
  const endpoint = guardianEndpointFor(lockPath, token);
  await mkdir(claimPath);
  let server: Server | undefined;
  try {
    server = await startGuardian(endpoint);
    await writeFile(path.join(claimPath, markerName), "", { flag: "wx" });
    return { claimPath, endpoint, markerName, server };
  } catch (err) {
    if (server) await closeGuardian(server, endpoint);
    await rmdir(claimPath).catch(() => undefined);
    throw err;
  }
}

async function discardLockClaim(claim: PreparedLockClaim): Promise<void> {
  await closeGuardian(claim.server, claim.endpoint);
  await unlink(path.join(claim.claimPath, claim.markerName)).catch(() => undefined);
  await rmdir(claim.claimPath).catch(() => undefined);
}

async function recoverReleasedOrAbandonedLock(lockPath: string): Promise<boolean> {
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
  const held = entries.find((name) => HELD_MARKER.test(name));
  const token = held ? HELD_MARKER.exec(held)?.[1] : undefined;
  const endpoint = token ? guardianEndpointFor(lockPath, token) : undefined;
  const recoverable = released || (endpoint !== undefined && !(await guardianIsAlive(endpoint)));
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
  if (endpoint && process.platform !== "win32") await unlink(endpoint).catch(() => undefined);
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
 * Reserve one output stem across processes. A fully initialized claim becomes
 * visible through one directory rename, so no empty live lock can be mistaken
 * for an abandoned initialization. Its guardian endpoint is owned by the OS:
 * it survives a process pause, closes on a crash, and cannot be confused by PID
 * reuse. Release first marks ownership as released, so failed cleanup remains
 * recoverable.
 */
export async function acquireOutputGroupLock(group: OutputGroup): Promise<OutputGroupLock> {
  let lockPath: string;
  try {
    lockPath = await outputGroupLockPathFor(group);
  } catch (err) {
    throw new LocalOpError(
      "output.lockFailed",
      `Failed to resolve output reservation ${JSON.stringify(group.stem)}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let claim: PreparedLockClaim;
    try {
      claim = await prepareLockClaim(lockPath);
    } catch (err) {
      throw new LocalOpError(
        "output.lockFailed",
        `Failed to prepare output reservation ${JSON.stringify(group.stem)}: ${(err as Error).message}`,
        { cause: err },
      );
    }

    try {
      await rename(claim.claimPath, lockPath);
    } catch (err) {
      await discardLockClaim(claim);
      let lockExists = false;
      try {
        lockExists = (await stat(lockPath)).isDirectory();
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException).code !== "ENOENT") throw statErr;
      }
      if (!lockExists) {
        throw new LocalOpError(
          "output.lockFailed",
          `Failed to reserve output stem ${JSON.stringify(group.stem)}: ${(err as Error).message}`,
          { cause: err },
        );
      }
      if (await recoverReleasedOrAbandonedLock(lockPath)) continue;
      throw new LocalOpError("output.busy", `Another operation is publishing output stem ${JSON.stringify(group.stem)}. Try again.`, {
        cause: err,
      });
    }

    const ownerPath = path.join(lockPath, claim.markerName);
    let didRelease = false;
    const release = async (): Promise<void> => {
      if (didRelease) return;
      didRelease = true;
      const releasedPath = path.join(lockPath, `released-${claim.markerName.slice("held-".length)}`);
      try {
        await rename(ownerPath, releasedPath);
      } catch {
        await writeFile(releasedPath, "", { flag: "wx" }).catch(() => undefined);
      }
      await closeGuardian(claim.server, claim.endpoint);
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
  return normalizedOutputGroup({ dir, stem, ext, sidecarExt: SIDECAR_EXT });
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
  const sx = escapeRegex(group.sidecarExt);
  const imageExts = [...new Set([...SUPPORTED_IMAGE_EXTENSIONS, group.ext])]
    .filter((ext) => ext !== group.sidecarExt)
    .map(escapeRegex)
    .join("|");
  // Case-insensitive: on macOS/Windows a `photo`-stem output collides with a
  // `Photo`-stem group, so it must be detected as a sibling regardless of case.
  const imagePattern = new RegExp(`^${stem}(?:-\\d+)?\\.(?:${imageExts})$`, "i");
  const sidecarPattern = new RegExp(`^${stem}(?:-\\d+)?\\.${sx}$`, "i");
  return entries
    .filter((name) => imagePattern.test(name) || sidecarPattern.test(name))
    .map((name) => path.join(group.dir, name))
    .sort();
}

function artifactIdentity(filePath: string, sidecarExt: string): string {
  const name = path.basename(filePath);
  const extension = path.extname(name).slice(1).toLowerCase();
  const stem = name.slice(0, -(extension.length + 1)).normalize("NFC").toLowerCase();
  return `${extension === sidecarExt.toLowerCase() ? "sidecar" : "image"}:${stem}`;
}

/**
 * Group-scoped output assertion.
 *
 * - Without `allowOverwrite`: any existing group sibling blocks. This is
 *   stricter than the previous plan-scoped check by design — a stem that
 *   carries any prior-run artifact is not safe to write into without an
 *   explicit overwrite intent.
 *
 * - With `allowOverwrite`: planned artifact slots may exist (they will be
 *   replaced). An image slot is extension-independent, so a planned PNG may
 *   replace an old JPEG; sidecars remain their own artifact kind. Group
 *   siblings outside the planned slots are reported as `output.staleSiblings`.
 */
export function assertOutputGroupAvailable(group: OutputGroup, plannedFiles: string[], allowOverwrite: boolean): void {
  const plannedResolved = new Set<string>();
  const plannedArtifacts = new Set<string>();
  for (const p of plannedFiles) {
    const r = path.resolve(p);
    if (plannedResolved.has(r)) {
      throw new LocalOpError("output.duplicate", `Multiple planned outputs resolve to the same path: ${p}`);
    }
    plannedResolved.add(r);
    plannedArtifacts.add(artifactIdentity(p, group.sidecarExt));
  }

  const existing = siblingsOnDisk(group);
  if (existing.length === 0) return;

  if (!allowOverwrite) {
    throw new LocalOpError("output.exists", `Output exists: ${existing[0]}. Use overwrite to allow.`);
  }
  // An image in another supported format is the same logical artifact slot and
  // is replaceable under explicit overwrite. JSON remains a distinct kind, so
  // a sidecar-only verb cannot silently adopt an orphan image (or vice versa).
  const stale = existing.filter((p) => !plannedArtifacts.has(artifactIdentity(p, group.sidecarExt)));
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

/** Remove old supported image formats only after their replacement published. */
export async function removeSupersededImageFormats(group: OutputGroup, plannedImages: string[]): Promise<void> {
  const plannedExtensions = new Map<string, string>();
  for (const filePath of plannedImages) {
    const extension = path.extname(filePath).slice(1).toLowerCase();
    plannedExtensions.set(artifactIdentity(filePath, group.sidecarExt), extension);
  }

  const stale = siblingsOnDisk(group).filter((filePath) => {
    const extension = path.extname(filePath).slice(1).toLowerCase();
    if (!SUPPORTED_IMAGE_EXTENSIONS.includes(extension)) return false;
    const replacementExtension = plannedExtensions.get(artifactIdentity(filePath, group.sidecarExt));
    return replacementExtension !== undefined && replacementExtension !== extension;
  });
  const failures: Error[] = [];
  for (const filePath of stale) {
    try {
      await unlink(filePath);
    } catch (err) {
      failures.push(err as Error);
    }
  }
  if (failures.length > 0) {
    throw new LocalOpError(
      "output.cleanupFailed",
      `Published replacement output but failed to remove ${failures.length} superseded image format(s).`,
      { cause: new AggregateError(failures) },
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
  const group = createOutputGroup(dir, stem, "png");
  const sidecars = plannedSidecarPaths(group, count, count);
  const imagePlaceholders = sidecars.map((sidecar) => sidecar.replace(/\.json$/i, ".png"));
  assertOutputGroupAvailable(group, [...imagePlaceholders, ...sidecars], allowOverwrite);
}
