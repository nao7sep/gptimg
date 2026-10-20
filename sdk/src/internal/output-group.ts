import { existsSync, lstatSync, readdirSync } from "node:fs";
import { realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { GptImgError, fsError } from "../errors.ts";
import { refuse } from "../refusal.ts";
import { SUPPORTED_IMAGE_EXTENSIONS } from "../image/formats.ts";
import { refuseNewerSidecar } from "../sidecar/read.ts";
import { indexSuffix } from "./output-naming.ts";

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
  // path.join mirrors the publication path, while path.normalize collapses `.`
  // and `..` aliases before any reservation or sibling decision is made; output
  // folders are absolute, so no working directory is involved.
  const target = path.normalize(path.join(group.dir, `${group.stem}${TARGET_MARKER}`));
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
    throw fsError(err, "Failed to resolve output directory", normalized.dir);
  }
  const stem = normalized.stem.normalize("NFC").toLowerCase();
  // Check and claim in one synchronous step, after the last await.
  for (const live of liveReservations) {
    if (live.directory === directory && (isGroupSlot(stem, live.stem) || isGroupSlot(live.stem, stem))) {
      refuse(
        "output.busy",
        `Another operation in this process is writing output ${JSON.stringify(normalized.stem)} or its numbered siblings. Try again when it finishes.`,
        { subject: path.join(normalized.dir, normalized.stem) },
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
    throw fsError(err, "Failed to scan output directory", group.dir);
  }
  const stem = escapeRegex(group.stem.normalize("NFC"));
  const sx = escapeRegex(group.sidecarExt);
  const imageExts = [...new Set([...SUPPORTED_IMAGE_EXTENSIONS, group.ext])]
    .filter((ext) => ext !== group.sidecarExt)
    .map(escapeRegex)
    .join("|");
  // NFC and case-insensitive: canonical Unicode spellings and case variants
  // collide on standard macOS/Windows volumes. Keep discovered names for I/O.
  const imagePattern = new RegExp(`^${stem}(?:-\\d+)?\\.(?:${imageExts})$`, "i");
  const sidecarPattern = new RegExp(`^${stem}(?:-\\d+)?\\.${sx}$`, "i");
  return entries
    .filter((name) => imagePattern.test(name.normalize("NFC")) || sidecarPattern.test(name.normalize("NFC")))
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
 * (storage-path-conventions). Canonically equivalent Unicode spellings may
 * replace one another only when they identify the same directory entry.
 * A slot's image may change format, so only a same-format extension must
 * match exactly.
 */
export function refuseCaseOnlyRename(existing: string, planned: string, directoryEntries: readonly string[]): void {
  const actualName = path.basename(existing);
  const requestedName = path.basename(planned);
  const existingName = actualName.normalize("NFC");
  const plannedName = requestedName.normalize("NFC");
  const existingExt = path.extname(existingName);
  const plannedExt = path.extname(plannedName);
  const sameStem =
    existingName.slice(0, existingName.length - existingExt.length) ===
    plannedName.slice(0, plannedName.length - plannedExt.length);
  const sameFormat = existingExt.toLowerCase() === plannedExt.toLowerCase();
  if (sameStem && (!sameFormat || existingExt === plannedExt)) {
    const actualStem = actualName.slice(0, -path.extname(actualName).length);
    const requestedStem = requestedName.slice(0, -path.extname(requestedName).length);
    if (actualStem === requestedStem) return;
    // A normalization-insensitive filesystem can expose two spellings of one
    // entry. Elsewhere a spelling change would create a portable-name clash.
    // Compare in the existing format so an image may still change format.
    const requestedExistingFormat = `${requestedStem}${path.extname(actualName)}`;
    const distinctEntry = directoryEntries.includes(requestedExistingFormat);
    // Two separate hard links also become distinct files after replacement.
    if (!distinctEntry) {
      const requestedPath = path.join(path.dirname(planned), requestedExistingFormat);
      try {
        // Replacement acts on directory entries, including dangling symlinks,
        // rather than on the targets a symlink names.
        const actual = lstatSync(existing);
        const requested = lstatSync(requestedPath, { throwIfNoEntry: false });
        if (requested?.dev === actual.dev && requested.ino === actual.ino) return;
      } catch (err) {
        throw fsError(err, `Failed to inspect output filenames ${requestedPath} and`, existing);
      }
    }
    refuse(
      "output.normalizationConflict",
      `Refusing to replace ${existing} with ${requestedName}: the Unicode spellings would create separate files. ` +
        `Use the existing name, or remove the file first.`,
      { subject: existing },
    );
  }
  refuse(
    "output.caseConflict",
    `Refusing to replace ${existing} with ${plannedName}: the names differ only in case. ` +
      `Use the existing name, or remove the file first.`,
    { subject: existing },
  );
}

/**
 * Group-scoped output assertion.
 *
 * - Without `allowOverwrite`: any existing group sibling blocks: a stem that
 *   carries any earlier run's artifact is not safe to write into without an
 *   explicit overwrite intent.
 *
 * - With `allowOverwrite`: planned artifact slots may exist (they will be
 *   replaced, or cleared when the run does not fill them). An image slot is
 *   extension-independent, so a planned PNG may replace an old JPEG;
 *   sidecars remain their own artifact kind. Group
 *   siblings outside the planned slots are reported as `output.staleSiblings`,
 *   an existing sidecar in a newer format as `sidecar.newerFormat`, and an
 *   existing member whose name differs from its planned one only in case as
 *   `output.caseConflict`. A Unicode spelling change that would create a
 *   distinct file is refused as `output.normalizationConflict`.
 */
export function assertOutputGroupAvailable(group: OutputGroup, plannedFiles: string[], allowOverwrite: boolean): void {
  const plannedResolved = new Set<string>();
  const plannedArtifacts = new Map<string, string>();
  for (const p of plannedFiles) {
    const r = path.normalize(p);
    if (plannedResolved.has(r)) {
      throw new GptImgError("output.duplicate", `Multiple planned outputs resolve to the same path: ${p}`);
    }
    plannedResolved.add(r);
    plannedArtifacts.set(artifactIdentity(p, group.sidecarExt), p);
  }

  const existing = siblingsOnDisk(group);
  if (existing.length === 0) return;

  if (!allowOverwrite) {
    refuse("output.exists", `Output exists: ${existing[0]}. Use overwrite to allow.`, { subject: existing[0]! });
  }
  // An image in another supported format is the same logical artifact slot and
  // is replaceable under explicit overwrite. JSON remains a distinct kind, so
  // a sidecar-only verb cannot silently adopt an orphan image (or vice versa).
  const stale = existing.filter((p) => !plannedArtifacts.has(artifactIdentity(p, group.sidecarExt)));
  if (stale.length > 0) {
    const names = stale.map((p) => path.basename(p)).join(", ");
    refuse(
      "output.staleSiblings",
      `Refusing to overwrite: the artifact group "${group.stem}.${group.ext}" in ${group.dir} ` +
        `has ${stale.length} file(s) from a prior run that this run will not replace: ${names}. ` +
        `Delete them or choose a fresh outName.`,
      { subject: path.join(group.dir, group.stem) },
    );
  }
  // Replacement and slot cleanup may touch every existing member, so a newer
  // sidecar or a conflicting name refuses the whole group before any changes.
  const existingNames = existing.map((p) => path.basename(p));
  for (const p of existing) {
    const identity = artifactIdentity(p, group.sidecarExt);
    refuseCaseOnlyRename(p, plannedArtifacts.get(identity)!, existingNames);
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
 * Returns the files it could not remove; the run's published results stand,
 * so it never throws.
 */
export async function removeUnpublishedSlots(
  group: OutputGroup,
  ownedFiles: readonly string[],
  publishedFiles: readonly string[],
): Promise<string[]> {
  const owned = new Set(ownedFiles.map((filePath) => artifactIdentity(filePath, group.sidecarExt)));
  // Exact names: the pre-publication check refused case-only renames, so a
  // retained file has exactly a published name.
  const published = new Set(publishedFiles.map(fileName));
  let siblings: string[];
  try {
    siblings = siblingsOnDisk(group);
  } catch {
    // The run's results are already published, so a folder that cannot be
    // listed now must not fail it: report the owned slots still present
    // under this run's names, which is all that can be seen without a listing.
    return ownedFiles.filter((filePath) => !published.has(fileName(filePath)) && existsSync(filePath));
  }
  const sidecars = new Map(siblings
    .filter((filePath) => artifactIdentity(filePath, group.sidecarExt).startsWith("sidecar:"))
    .map((filePath) => [artifactIdentity(filePath, group.sidecarExt), filePath]));
  const leftovers = siblings.filter(
    (filePath) => owned.has(artifactIdentity(filePath, group.sidecarExt)) && !published.has(fileName(filePath)),
  );
  // Keep the governing sidecars until every image cleanup has completed.
  leftovers.sort((a, b) => Number(artifactIdentity(a, group.sidecarExt).startsWith("sidecar:")) -
    Number(artifactIdentity(b, group.sidecarExt).startsWith("sidecar:")));
  const kept: string[] = [];
  for (const filePath of leftovers) {
    const sidecarIdentity = artifactIdentity(filePath, group.sidecarExt).replace(/^image:/, "sidecar:");
    const sidecarPath = sidecars.get(sidecarIdentity) ??
      `${filePath.slice(0, -path.extname(filePath).length)}.${group.sidecarExt}`;
    try {
      refuseNewerSidecar(sidecarPath);
      await unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") kept.push(filePath);
    }
  }
  return kept;
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
