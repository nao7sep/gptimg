import { readFile } from "node:fs/promises";
import path from "node:path";
import { GptImgError, fsError } from "../errors.ts";
import { SIDECAR_FORMAT_VERSION } from "../format-versions.ts";
import { assertAbsolutePath } from "../internal/absolute-path.ts";
import { takeFormatVersion } from "../internal/format-version.ts";
import { formatZodError } from "../internal/zodError.ts";
import type { Sidecar } from "../types.ts";
import { SidecarSchema } from "./schema.ts";

/** The sidecar beside an image: `<stem>.json` in the same folder. */
export function sidecarPathBeside(imagePath: string): string {
  const base = path.basename(imagePath);
  const dot = base.lastIndexOf(".");
  return path.join(path.dirname(imagePath), `${dot > 0 ? base.slice(0, dot) : base}.json`);
}

/**
 * Read the sidecar at the absolute `sidecarPath` (`<image stem>.json`), in the
 * current format, as its typed record. An older format is malformed; a newer
 * one is refused. Either way the file is left unchanged.
 */
export async function readSidecar(sidecarPath: string): Promise<Sidecar> {
  assertAbsolutePath(sidecarPath, "sidecar path");
  let text: string;
  try {
    text = await readFile(sidecarPath, "utf-8");
  } catch (err) {
    throw fsError(err, "Failed to read sidecar", sidecarPath);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new GptImgError("sidecar.malformed", `Invalid JSON in sidecar at ${sidecarPath}`, {
      cause: err,
      subject: sidecarPath,
    });
  }
  return parseSidecar(parsed, sidecarPath);
}

/** A parsed sidecar body of the current format as its typed record, or `sidecar.malformed`/`sidecar.newerFormat`. */
function parseSidecar(parsed: unknown, subject: string): Sidecar {
  const body = takeFormatVersion(parsed, SIDECAR_FORMAT_VERSION, subject);
  // The schema validates; the record returned is the file's own body, so its
  // key order and any unknown keys survive a read-then-write unchanged.
  const r = SidecarSchema.safeParse(body);
  if (!r.success) throw malformed(subject, formatZodError(r.error));
  return { formatVersion: SIDECAR_FORMAT_VERSION, ...body } as Sidecar;
}

function malformed(subject: string, detail: string): GptImgError {
  return new GptImgError("sidecar.malformed", `Sidecar at ${subject} is invalid and was left unchanged: ${detail}`, {
    subject,
  });
}

/**
 * Refuse to replace an existing sidecar written in a newer format, so this
 * build never overwrites or removes metadata it cannot read
 * (store-recovery-conventions). An absent or unreadable file is left to the
 * caller's own overwrite decision.
 */
export async function refuseNewerSidecar(sidecarPath: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(sidecarPath, "utf-8"));
  } catch {
    return;
  }
  try {
    takeFormatVersion(parsed, SIDECAR_FORMAT_VERSION, sidecarPath);
  } catch (err) {
    if ((err as GptImgError).code === "sidecar.newerFormat") throw err;
  }
}
