import { readdirSync } from "node:fs";
import { realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { LocalOpError } from "../errors.js";
import { SUPPORTED_IMAGE_EXTENSIONS } from "../image/formats.js";
import { refuseNewerSidecar } from "../sidecar/read.js";
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
  // and `..` aliases before any reservation or sibling decision is made.
  const target = path.resolve(path.join(group.dir, `${group.stem}${TARGET_MARKER}`));
  const markedName = path.basename(target);
  return {
    ...group,
    dir: path.dirname(target),
    stem: markedName.slice(0, -TARGET_MARKER.length),
  };
}

/** Whether `name` is a slot of the group `stem`: the stem itself or `<stem>-<digits>`. */
function isGroupSlot(name: string, stem: string): boolean {
  return name === stem || (name.startsWith(`${stem}-`) && /^\d+$/.test(name.slice(stem.length + 1)));
}

interface LiveReservation {
  directory: string;
  stem: string;
}

/**
 * Output reservations of paid runs still in flight in this process. Callers
 * are scripts in one process, so an in-process registry is the whole
 * coordination: separate processes using the same explicit name at once are
 * not detected, and create-if-absent publication still refuses to clobber
 * without `overwrite`.
 */
const liveReservations = new Set<LiveReservation>();

export interface OutputReservation extends Disposable {
  release(): void;
}

/**
 * Reserve every slot a paid run can write or clear, before its provider call.
 * Two runs conflict when either stem is a slot of the other's group (the same
 * stem, or `foo` against `foo-1`), because each run's availability check and
 * overwrite cleanup cover its whole group: an overlapping run would make the
 * other fail or lose files after its charge. Directories are keyed by real
 * path and device/inode, so `.`, `..` and symlink aliases meet; stems by
 * case-folded NFC, as on standard macOS and Windows volumes.
 */
export async function reserveOutputGroup(group: OutputGroup): Promise<OutputReservation> {
  const normalized = normalizedOutputGroup(group);
  let directory: string;
  try {
    const canonicalDir = await realpath(normalized.dir);
    const identity = await stat(canonicalDir);
    directory = `${canonicalDir}\0${identity.dev}:${identity.ino}`;
  } catch (err) {
    throw new LocalOpError(
      "output.reserveFailed",
      `Failed to resolve output directory ${normalized.dir}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  const stem = normalized.stem.normalize("NFC").toLowerCase();
  // Check and claim in one synchronous step, after the last await.
  for (const live of liveReservations) {
    if (live.directory === directory && (isGroupSlot(stem, live.stem) || isGroupSlot(live.stem, stem))) {
      throw new LocalOpError(
        "output.busy",
        `Another operation in this process is writing output ${JSON.stringify(normalized.stem)} or its numbered siblings. Try again when it finishes.`,
      );
    }
  }
  const reservation: LiveReservation = { directory, stem };
  liveReservations.add(reservation);
  const release = (): void => {
    liveReservations.delete(reservation);
  };
  return { release, [Symbol.dispose]: release };
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
 * Refuse to replace `existing` with `planned`, the same output slot, when their
 * names differ only in case: a case-sensitive volume would keep both, and they
 * collide when copied to a standard macOS or Windows folder
 * (storage-path-conventions). A slot's image may change format, so only a
 * same-format extension must match exactly.
 */
export function refuseCaseOnlyRename(existing: string, planned: string): void {
  const existingName = path.basename(existing).normalize("NFC");
  const plannedName = path.basename(planned).normalize("NFC");
  const existingExt = path.extname(existingName);
  const plannedExt = path.extname(plannedName);
  const sameStem =
    existingName.slice(0, existingName.length - existingExt.length) ===
    plannedName.slice(0, plannedName.length - plannedExt.length);
  const sameFormat = existingExt.toLowerCase() === plannedExt.toLowerCase();
  if (sameStem && (!sameFormat || existingExt === plannedExt)) return;
  throw new LocalOpError(
    "output.caseConflict",
    `Refusing to replace ${existing} with ${plannedName}: the names differ only in case. ` +
      `Use the existing name, or remove the file first.`,
  );
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
 *   replaced, or cleared when the run does not fill them). An image slot is
 *   extension-independent, so a planned PNG may replace an old JPEG;
 *   sidecars remain their own artifact kind. Group
 *   siblings outside the planned slots are reported as `output.staleSiblings`,
 *   an existing sidecar in a newer format as `sidecar.newerFormat`, and an
 *   existing member whose name differs from its planned one only in case as
 *   `output.caseConflict`.
 */
export function assertOutputGroupAvailable(group: OutputGroup, plannedFiles: string[], allowOverwrite: boolean): void {
  const plannedResolved = new Set<string>();
  const plannedArtifacts = new Map<string, string>();
  for (const p of plannedFiles) {
    const r = path.resolve(p);
    if (plannedResolved.has(r)) {
      throw new LocalOpError("output.duplicate", `Multiple planned outputs resolve to the same path: ${p}`);
    }
    plannedResolved.add(r);
    plannedArtifacts.set(artifactIdentity(p, group.sidecarExt), p);
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
  // Replacement and slot cleanup may touch every existing member, so a newer
  // sidecar or a case-only rename refuses the whole group before any changes.
  for (const p of existing) {
    const identity = artifactIdentity(p, group.sidecarExt);
    refuseCaseOnlyRename(p, plannedArtifacts.get(identity)!);
    if (identity.startsWith("sidecar:")) refuseNewerSidecar(p);
  }
}

function fileKey(filePath: string): string {
  return path.basename(filePath).normalize("NFC").toLowerCase();
}

function fileName(filePath: string): string {
  return path.basename(filePath).normalize("NFC");
}

/**
 * Every artifact slot a generate/edit run owns: the `requested` slots it
 * reserved before the provider call, named for that count, and the slots the
 * response names, `max(requested, returned)` of them. Images are listed with
 * the group's extension; an image slot is extension-independent, so any
 * supported format in that slot is the same artifact.
 */
export function ownedSlotFiles(group: OutputGroup, requested: number, returned: number): string[] {
  const files = new Map<string, string>();
  const addSlots = (count: number): void => {
    for (const sidecar of plannedSidecarPaths(group, count, count)) {
      const image = `${sidecar.slice(0, -(group.sidecarExt.length + 1))}.${group.ext}`;
      files.set(fileKey(image), image);
      files.set(fileKey(sidecar), sidecar);
    }
  };
  addSlots(requested);
  addSlots(Math.max(requested, returned));
  return [...files.values()];
}

/**
 * After an overwrite publishes, clear whatever a prior run left in the slots
 * this run owns but did not fill: an old image format beside its replacement,
 * or the image and sidecar of a slot whose new item failed. The group then
 * holds exactly this run's files, unless a newer sidecar now protects a slot.
 */
export async function removeUnpublishedSlots(
  group: OutputGroup,
  ownedFiles: readonly string[],
  publishedFiles: readonly string[],
): Promise<void> {
  const owned = new Set(ownedFiles.map((filePath) => artifactIdentity(filePath, group.sidecarExt)));
  // Exact names: the pre-publication check refused case-only renames, so a
  // retained file has exactly a published name.
  const published = new Set(publishedFiles.map(fileName));
  const siblings = siblingsOnDisk(group);
  const sidecars = new Map(siblings
    .filter((filePath) => artifactIdentity(filePath, group.sidecarExt).startsWith("sidecar:"))
    .map((filePath) => [artifactIdentity(filePath, group.sidecarExt), filePath]));
  const leftovers = siblings.filter(
    (filePath) => owned.has(artifactIdentity(filePath, group.sidecarExt)) && !published.has(fileName(filePath)),
  );
  // Keep the governing sidecars until every image cleanup has completed.
  leftovers.sort((a, b) => Number(artifactIdentity(a, group.sidecarExt).startsWith("sidecar:")) -
    Number(artifactIdentity(b, group.sidecarExt).startsWith("sidecar:")));
  const failures: Error[] = [];
  for (const filePath of leftovers) {
    const sidecarIdentity = artifactIdentity(filePath, group.sidecarExt).replace(/^image:/, "sidecar:");
    const sidecarPath = sidecars.get(sidecarIdentity) ??
      `${filePath.slice(0, -path.extname(filePath).length)}.${group.sidecarExt}`;
    refuseNewerSidecar(sidecarPath);
    try {
      await unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") failures.push(err as Error);
    }
  }
  if (failures.length > 0) {
    throw new LocalOpError(
      "output.cleanupFailed",
      `Published this run's output but failed to remove ${failures.length} file(s) a prior run left in its slots.`,
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
  assertOutputGroupAvailable(group, ownedSlotFiles(group, count, 0), allowOverwrite);
}
