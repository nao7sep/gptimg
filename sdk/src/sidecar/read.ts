import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { GptImgError, fsError } from "../errors.ts";
import { SIDECAR_FORMAT_VERSION } from "../format-versions.ts";
import { assertAbsolutePath } from "../internal/absolute-path.ts";
import { formatZodError } from "../internal/zodError.ts";
import type { Sidecar, SidecarKind } from "../types.ts";
import { SidecarV1Schema, SidecarV2Schema } from "./schema.ts";

/** The version an unmarked sidecar reads as: v0.1.0's format, which version 1 kept. */
const UNVERSIONED = 1;

/**
 * Read the sidecar at the absolute `sidecarPath` (`<image stem>.json`), any
 * supported format, as its typed record. Format 1 files carry no kind or
 * writer: the kind is told apart by shape (vision: `response.verdict`; edit:
 * `request.input`; otherwise generate) and `writer` is null. A newer format is
 * refused and the file left unchanged.
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

/** A parsed sidecar body of any supported format as its typed record, or `sidecar.malformed`/`sidecar.newerFormat`. */
export function parseSidecar(parsed: unknown, subject: string): Sidecar {
  const version = formatVersionOf(parsed, subject);
  const { formatVersion: _omit, ...body } = parsed as Record<string, unknown>;
  // The schemas validate; the record returned is the file's own body, so its
  // key order and any unknown keys survive a read-then-write unchanged.
  if (version === 1) {
    const r = SidecarV1Schema.safeParse(body);
    if (!r.success) throw malformed(subject, formatZodError(r.error));
    return { formatVersion: 1, kind: kindOfV1(r.data), writer: null, ...body } as Sidecar;
  }
  const r = SidecarV2Schema.safeParse(body);
  if (!r.success) throw malformed(subject, formatZodError(r.error));
  return { formatVersion: 2, ...body } as Sidecar;
}

function formatVersionOf(parsed: unknown, subject: string): number {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw malformed(subject, "must be a JSON object");
  }
  // Only an absent field means unversioned; `null` is malformed, as for profiles.
  const marked = (parsed as { formatVersion?: unknown }).formatVersion;
  const version = marked === undefined ? UNVERSIONED : marked;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw malformed(subject, "formatVersion is not a positive integer");
  }
  if (version > SIDECAR_FORMAT_VERSION) {
    throw new GptImgError(
      "sidecar.newerFormat",
      `${subject} has format version ${version}, newer than the ${SIDECAR_FORMAT_VERSION} this gptimgsdk reads; it was left unchanged.`,
      { subject, details: { expected: SIDECAR_FORMAT_VERSION, actual: version } },
    );
  }
  return version;
}

function kindOfV1(body: { request: Record<string, unknown>; response: unknown }): SidecarKind {
  const response = body.response as { verdict?: unknown } | null;
  if (response && typeof response === "object" && "verdict" in response) return "vision";
  if ("input" in body.request) return "edit";
  return "generate";
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
export function refuseNewerSidecar(sidecarPath: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(sidecarPath, "utf-8"));
  } catch {
    return;
  }
  try {
    formatVersionOf(parsed, sidecarPath);
  } catch (err) {
    if ((err as GptImgError).code === "sidecar.newerFormat") throw err;
  }
}
