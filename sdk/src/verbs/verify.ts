import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SdkContext } from "../context.ts";
import { GptImgError, fsError, throwIfAborted } from "../errors.ts";
import sharp from "../image/sharp.ts";
import { detectFormat } from "../image/detectFormat.ts";
import { hash } from "../image/hash.ts";
import { withVerbLogger } from "../internal/local-verb.ts";
import type { RefusedResult } from "../refusal.ts";
import { readSidecar, sidecarPathBeside } from "../sidecar/read.ts";
import type { Sidecar, VerifyArgs, VerifyFinding, VerifyResult } from "../types.ts";
import type { VerbCallOptions } from "./options.ts";
import { validateVerifyArgs } from "./schemas.ts";

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
  validateVerifyArgs(args);
  const imagePath = args.in;
  const base = path.basename(imagePath);
  const sidecarPath = sidecarPathBeside(imagePath);

  return withVerbLogger(ctx, "verify", opts, async (logger) => {
    throwIfAborted(opts.signal);
    let bytes: Buffer;
    try {
      bytes = await readFile(imagePath);
    } catch (err) {
      throw fsError(err, "Failed to read image", imagePath);
    }
    const findings: VerifyFinding[] = [];
    const sha256 = hash(bytes);

    throwIfAborted(opts.signal);
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

    throwIfAborted(opts.signal);
    let format: string | null = null;
    try {
      format = (await detectFormat(bytes)).format;
      // The header alone passes a truncated or damaged file; decoding every pixel does not.
      await sharp(bytes).raw().toBuffer();
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

    logger.emit("info", "stats", { event: "verb.done", output: null, stats: { input: imagePath, sidecar: sidecarPath, findings: findings.map((f) => f.code) } });
    return {
      status: "completed" as const,
      input: imagePath,
      sidecarPath,
      ok: findings.length === 0,
      findings,
      record,
    };
  });
}
