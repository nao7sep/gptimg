import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SdkContext } from "../context.ts";
import { GptImgError, fsError } from "../errors.ts";
import { detectFormat } from "../image/detectFormat.ts";
import { hash } from "../image/hash.ts";
import { assertAbsolutePath } from "../internal/absolute-path.ts";
import { withVerbLogger } from "../internal/local-verb.ts";
import type { RefusedResult } from "../refusal.ts";
import { readSidecar } from "../sidecar/read.ts";
import type { Sidecar, VerifyArgs, VerifyFinding, VerifyResult } from "../types.ts";
import type { VerbCallOptions } from "./options.ts";

/**
 * Check a published paid image against the sidecar beside it before a
 * consumer relies on it (sdk-conventions, *Verify what was written*): the
 * sidecar is present and readable in a supported format, one of its file
 * entries carries the image's SHA-256 under the image's own name, and the
 * image decodes in the format the entry records. Findings are results, not
 * errors; the call throws only when the image itself cannot be read.
 */
export async function verifyImpl(
  ctx: SdkContext,
  args: VerifyArgs,
  opts: VerbCallOptions = {},
): Promise<VerifyResult | RefusedResult> {
  if (typeof args !== "object" || args === null) {
    throw new GptImgError("args.invalid", "verify: args must be an object.", { details: { field: "args", constraint: "object" } });
  }
  assertAbsolutePath(args.in, "in");
  const imagePath = args.in;
  const base = path.basename(imagePath);
  const dot = base.lastIndexOf(".");
  const sidecarPath = path.join(path.dirname(imagePath), `${dot > 0 ? base.slice(0, dot) : base}.json`);

  return withVerbLogger(ctx, "verify", opts, async (logger) => {
    let bytes: Buffer;
    try {
      bytes = await readFile(imagePath);
    } catch (err) {
      throw fsError(err, "Failed to read image", imagePath);
    }
    const findings: VerifyFinding[] = [];
    const sha256 = hash(bytes);

    let record: Sidecar | null = null;
    try {
      record = await readSidecar(sidecarPath);
    } catch (err) {
      const code = (err as GptImgError).code;
      if (code === "fs.notFound") {
        findings.push({ code: "sidecar.missing", message: `No sidecar at ${sidecarPath}.` });
      } else if (code === "sidecar.malformed" || code === "sidecar.newerFormat") {
        findings.push({ code, message: (err as Error).message });
      } else {
        throw err;
      }
    }

    let format: string | null = null;
    try {
      format = (await detectFormat(bytes)).format;
    } catch (err) {
      findings.push({ code: "image.undecodable", message: `${imagePath} does not decode: ${(err as Error).message}` });
    }

    if (record !== null) {
      const entry = record.files.find((file) => file.sha256 === sha256);
      if (!entry) {
        findings.push({
          code: "sidecar.hashMismatch",
          message: `No file entry in ${sidecarPath} carries the SHA-256 of ${imagePath}; the image or the sidecar was replaced.`,
        });
      } else {
        if (entry.name !== base) {
          findings.push({
            code: "sidecar.nameMismatch",
            message: `The matching file entry in ${sidecarPath} names ${JSON.stringify(entry.name)}, not ${JSON.stringify(base)}.`,
          });
        }
        if (format !== null && entry.format !== format) {
          findings.push({
            code: "image.formatMismatch",
            message: `${imagePath} decodes as ${format}, but its file entry records ${entry.format}.`,
          });
        }
      }
    }

    await logger.info("response", findings.length === 0 ? "verified" : "verification findings", {
      input: imagePath,
      sidecar: sidecarPath,
      findings: findings.map((f) => f.code),
    });
    return {
      status: "completed" as const,
      input: imagePath,
      sidecarPath,
      ok: findings.length === 0,
      findings,
      record,
      logPath: logger.handle.path,
    };
  });
}
