import { readdirSync } from "node:fs";
import path from "node:path";
import { LocalOpError } from "../errors.js";
import { imageFileName } from "./output-naming.js";

/**
 * The artifact group produced by a single `generate` or `edit` invocation:
 * a stem plus an image extension plus a sidecar extension. Membership is
 * defined purely by filename pattern in `dir`:
 *
 *   - `<stem>.<ext>`                  — single output (n=1)
 *   - `<stem>-<digits>.<ext>`         — indexed multi-output (any width)
 *   - `<stem>.<sidecarExt>`           — sidecar
 *
 * Chroma-derived siblings (`-mask`, `-chroma`, `-verify-preview`) are NOT
 * group members; they belong to a different verb's output and must not be
 * touched by generate/edit overwrite logic.
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

export function sidecarPath(group: OutputGroup): string {
  return path.join(group.dir, `${group.stem}.${group.sidecarExt}`);
}

export function plannedImagePaths(
  group: OutputGroup,
  count: number,
  suffixWidth: number,
): string[] {
  const paths: string[] = [];
  for (let i = 1; i <= count; i++) {
    paths.push(path.join(group.dir, imageFileName(group.stem, i, suffixWidth, group.ext)));
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
  const sidecarPattern = new RegExp(`^${stem}\\.${sx}$`);
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
