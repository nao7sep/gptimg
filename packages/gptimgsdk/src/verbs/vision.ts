import type { RefusedResult } from "../refusal.ts";
import { callPolicy, requireCredentials, type SdkContext } from "../context.ts";
import { sidecarWriter } from "../sidecar/writer.ts";
import { defaultModelFor } from "../ai-models.ts";
import { resolveModel } from "../providers/openai/client.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { GptImgError, fsError } from "../errors.ts";
import { RefusalSignal } from "../refusal.ts";
import { hash } from "../image/hash.ts";
import { ensureOutputDir } from "../internal/output-files.ts";
import { reserveOutputGroup, assertOutputGroupAvailable, createOutputGroup } from "../internal/output-group.ts";
import { withVerbLogger } from "../internal/local-verb.ts";
import { singleLine } from "../internal/textCleanup.ts";
import type { Logger } from "../log/index.ts";
import { maskDiagnosticCopy } from "../log/mask.ts";
import { resolveNetworkForCall } from "../network/index.ts";
import { resolveVisionDetail, resolveVisionReasoning } from "../policy/model-check.ts";
import { validateVisionSection } from "../policy/schemas.ts";
import { writeSidecar } from "../sidecar/write.ts";
import { getProvider } from "../providers/index.ts";
import { detectFormat } from "../image/detectFormat.ts";
import { shrinkForVision } from "../image/shrinkForVision.ts";
import type {
  FilePublication,
  VisionSidecar,
  VisionDetail,
  VisionArgs,
  VisionResult,
} from "../types.ts";
import type { VerbCallOptions } from "./options.ts";
import { validateVisionArgs } from "./schemas.ts";
import { defaultStem } from "../internal/paths.ts";

import { VISION_DEFAULTS } from "./defaults.ts";

export type VisionContext = SdkContext;

interface PreparedImage {
  path: string;
  /** SHA-256 of the input file as read, before any shrink. */
  sha256: string;
  data: Uint8Array;
  format: string;
  detail: VisionDetail | undefined;
  shrink: {
    applied: boolean;
    originalWidth: number;
    originalHeight: number;
    outputWidth: number;
    outputHeight: number;
  };
}

async function prepareImage(
  imagePath: string,
  fit: { width: number; height: number },
  detail: VisionDetail | undefined,
  logger: Logger,
): Promise<PreparedImage> {
  let raw: Buffer;
  try {
    raw = await readFile(imagePath);
  } catch (err) {
    throw fsError(err, "Failed to read image", imagePath);
  }
  const shrink = await shrinkForVision(raw, fit);
  await logger.info("write", "prepared vision input", {
    path: path.basename(imagePath),
    shrink: {
      applied: shrink.applied,
      originalWidth: shrink.originalWidth,
      originalHeight: shrink.originalHeight,
      outputWidth: shrink.outputWidth,
      outputHeight: shrink.outputHeight,
    },
  });
  const fmt = await detectFormat(shrink.buffer);
  return {
    path: imagePath,
    sha256: hash(raw),
    data: new Uint8Array(shrink.buffer),
    format: fmt.format,
    detail,
    shrink: {
      applied: shrink.applied,
      originalWidth: shrink.originalWidth,
      originalHeight: shrink.originalHeight,
      outputWidth: shrink.outputWidth,
      outputHeight: shrink.outputHeight,
    },
  };
}

export async function visionImpl(
  ctx: VisionContext,
  args: VisionArgs,
  opts: VerbCallOptions = {},
): Promise<VisionResult | RefusedResult> {
  validateVisionArgs(args);
  const signal = opts.signal;
  // The check is a scalar instruction; normalize it to a single line once at the
  // input boundary so the same cleaned value is sent to the model and stored in
  // the sidecar.
  const check = singleLine(args.check);

  return withVerbLogger(ctx, "vision", opts, async (logger) => {
    const resolved = requireCredentials(ctx);
    await logger.info("resolve", "apiKey resolved", {
      apiKeySource: resolved.apiKeySource,
      provider: resolved.redacted.provider,
    });

    const policy = callPolicy(ctx, args.policy);
    const network = resolveNetworkForCall(policy);
    const section = validateVisionSection(policy.vision);
    const { shrink: configuredShrink, detail: configuredDetail, reasoning: configuredReasoning, ...sectionParams } = section;
    // The model, its effort and its detail are settled, and the effort checked against the
    // model's row, before the call, so the log and the sidecar name what is sent.
    const model = resolveModel(sectionParams.model, defaultModelFor("openai", "vision"));
    const reasoning = resolveVisionReasoning(model, configuredReasoning);
    const params = { ...sectionParams, model, ...(reasoning !== undefined && { reasoning }) };
    const shrink = configuredShrink ?? VISION_DEFAULTS.shrink;
    const detail = resolveVisionDetail(model, configuredDetail);

    // Resolve + guard the sidecar path before the (paid) provider call so a
    // name collision fails fast without spending, like generate/edit.
    const outDir = args.outDir ?? path.dirname(Array.isArray(args.in) ? args.in[0]! : args.in);
    await ensureOutputDir(outDir);
    const stem = args.outName ?? defaultStem();
    const stemPath = path.join(outDir, stem);
    const outputGroup = createOutputGroup(outDir, stem, "json");
    using _outputReservation = await reserveOutputGroup(outputGroup);
    assertOutputGroupAvailable(outputGroup, [`${stemPath}.json`], args.overwrite ?? false);

    const inputs = Array.isArray(args.in) ? args.in : [args.in];
    const prepared = await Promise.all(
      inputs.map((p) => prepareImage(p, shrink, detail, logger)),
    );

    await logger.info("request", "calling provider.vision", {
      provider: resolved.redacted.provider,
      model: params.model ?? null,
      images: prepared.length,
    });

    const provider = getProvider(resolved.redacted.provider);
    const providerResult = await provider.vision({
      check,
      images: prepared.map((p) => ({
        data: p.data,
        format: p.format,
        ...(p.detail !== undefined && { detail: p.detail }),
      })),
      params,
      profile: resolved,
      network: {
        primary: network.imageVision,
        download: network.imageDownload,
        logger,
        signal,
      },
    });
    await logger.info("response", "provider.vision returned", {
      ok: providerResult.verdict.ok,
      score: providerResult.verdict.score,
    });

    const record = maskDiagnosticCopy({
      formatVersion: 2,
      kind: "vision",
      writer: sidecarWriter(ctx),
      request: {
        ...params,
        check,
        ...(detail !== undefined && { detail }),
        inputs: prepared.map((p) => ({
          name: path.basename(p.path),
          sha256: p.sha256,
          shrink: p.shrink,
        })),
      },
      response: {
        verdict: providerResult.verdict,
        raw: providerResult.raw,
      },
      files: [],
    }, [resolved.apiKey]) as VisionSidecar;
    // The verdict was paid for: a sidecar that cannot be written is reported,
    // never thrown, and the record stays in the result.
    const sidecarPath = `${stemPath}.json`;
    let sidecar: FilePublication = { status: "published" };
    try {
      await writeSidecar(sidecarPath, record, { overwrite: args.overwrite ?? false });
      await logger.info("write", "wrote sidecar", { name: path.basename(sidecarPath) });
    } catch (err) {
      const failure = err instanceof RefusalSignal
        ? { code: err.refusal.code, message: err.refusal.message }
        : err instanceof GptImgError
          ? { code: err.code, message: err.message }
          : { code: "internal.unexpected" as const, message: (err as Error)?.message ?? String(err) };
      sidecar = { status: "failed", ...failure, effect: "unknown" };
      await logger.warn("write", "vision sidecar could not be published", { name: path.basename(sidecarPath), error: failure.message });
    }

    return {
      ok: providerResult.verdict.ok,
      score: providerResult.verdict.score,
      reasons: providerResult.verdict.reasons,
      raw: providerResult.raw,
      sidecarPath,
      sidecar,
      record,
      logPath: logger.handle.path,
      status: "completed" as const,
    };
  });
}
