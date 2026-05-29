import { readdirSync } from "node:fs";
import path from "node:path";
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

const SIDECAR_EXT = "json";

export function createOutputGroup(
  dir: string,
  stem: string,
  ext: string,
): OutputGroup {
  return { dir, stem, ext, sidecarExt: SIDECAR_EXT };
}

/**
 * The sidecar path for the image at `index` in a group of `suffixWidth`.
 * For n=1 this returns `<stem>.<sidecarExt>`; for n>1 it returns
 * `<stem>-<index>.<sidecarExt>` matching the image's index suffix.
 */
export function sidecarPathFor(
  group: OutputGroup,
  index: number,
  suffixWidth: number,
): string {
  return path.join(
    group.dir,
    `${group.stem}${indexSuffix(index, suffixWidth)}.${group.sidecarExt}`,
  );
}

export function plannedSidecarPaths(
  group: OutputGroup,
  count: number,
  suffixWidth: number,
): string[] {
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
    throw new LocalOpError(
      "output.scanFailed",
      `Failed to scan output directory ${group.dir}: ${e.message}`,
      { cause: err },
    );
  }
  const stem = escapeRegex(group.stem);
  const ext = escapeRegex(group.ext);
  const sx = escapeRegex(group.sidecarExt);
  const imagePattern = new RegExp(`^${stem}(?:-\\d+)?\\.${ext}$`);
  const sidecarPattern = new RegExp(`^${stem}(?:-\\d+)?\\.${sx}$`);
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
export function assertOutputGroupAvailable(
  group: OutputGroup,
  plannedFiles: string[],
  allowOverwrite: boolean,
): void {
  const plannedResolved = new Set<string>();
  for (const p of plannedFiles) {
    const r = path.resolve(p);
    if (plannedResolved.has(r)) {
      throw new LocalOpError(
        "output.duplicate",
        `Multiple planned outputs resolve to the same path: ${p}`,
      );
    }
    plannedResolved.add(r);
  }

  const existing = siblingsOnDisk(group);
  if (existing.length === 0) return;

  if (!allowOverwrite) {
    throw new LocalOpError(
      "output.exists",
      `Output exists: ${existing[0]}. Use overwrite to allow.`,
    );
  }
  const stale = existing.filter((p) => !plannedResolved.has(path.resolve(p)));
  if (stale.length > 0) {
    const names = stale.map((p) => path.basename(p)).join(", ");
    throw new LocalOpError(
      "output.staleSiblings",
      `Refusing to overwrite: the artifact group "${group.stem}.${group.ext}" in ${group.dir} ` +
        `has ${stale.length} file(s) from a prior run that this run will not replace: ${names}. ` +
        `Delete them or choose a fresh --out-name.`,
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
export function assertStemAvailable(
  dir: string,
  stem: string,
  count: number,
  allowOverwrite: boolean,
): void {
  const sidecarGroup = createOutputGroup(dir, stem, SIDECAR_EXT);
  assertOutputGroupAvailable(
    sidecarGroup,
    plannedSidecarPaths(sidecarGroup, count, count),
    allowOverwrite,
  );
}
