import path from "node:path";
import type { RefusedResult } from "../refusal.ts";
import { callPolicy, requireCredentials, type SdkContext } from "../context.ts";
import { sidecarWriter } from "../sidecar/writer.ts";
import { defaultModelFor } from "../ai-models.ts";
import { resolveModel } from "../providers/openai/client.ts";
import { ensureOutputDir } from "../internal/output-files.ts";
import {
  reserveOutputGroup,
  assertStemAvailable,
  createOutputGroup,
} from "../internal/output-group.ts";
import { outputStemLocation, withVerbLogger } from "../internal/local-verb.ts";
import { multiline } from "../internal/textCleanup.ts";
import { resolveNetworkForCall } from "../network/index.ts";
import { checkImageParams, resolveGenerateModeration } from "../policy/model-check.ts";
import { validateChromaSection, validateGenerateSection } from "../policy/schemas.ts";
import { getProvider } from "../providers/index.ts";
import type { GenerateArgs, GenerateRequestRecord, GenerateResult } from "../types.ts";
import type { VerbCallOptions } from "./options.ts";
import { publishProviderImages } from "./image-outputs.ts";
import { validateGenerateArgs } from "./schemas.ts";
import { defaultStem } from "../internal/paths.ts";

export type GenerateContext = SdkContext;

export async function generateImpl(
  ctx: GenerateContext,
  args: GenerateArgs,
  opts: VerbCallOptions = {},
): Promise<GenerateResult | RefusedResult> {
  validateGenerateArgs(args);
  const signal = opts.signal;
  // Normalize the free-text prompt once, at the input boundary, so the same
  // cleaned value is both sent to the provider and stored in the sidecar.
  // multiline() only drops edge blank lines and per-line trailing whitespace
  // (indentation and interior blanks preserved), so it is content-preserving
  // and safe for the outgoing request.
  const prompt = multiline(args.prompt);

  return withVerbLogger(ctx, "generate", opts, async (logger) => {
    const resolved = requireCredentials(ctx);

    const policy = callPolicy(ctx, args.policy);
    const network = resolveNetworkForCall(policy);
    const section = validateGenerateSection(policy.generate);
    const chromaSection = validateChromaSection(policy.chroma);

    // The model, its moderation and its values are settled before the call, so the events and
    // the sidecar name what is sent.
    const model = resolveModel(section.model, defaultModelFor("openai", "image-generate"));
    const moderation = resolveGenerateModeration(model);
    const params: Record<string, unknown> = {
      ...section,
      model,
      ...(moderation !== undefined && { moderation }),
    };
    checkImageParams("generate", params);
    const chromaColor =
      typeof chromaSection.color === "string" && chromaSection.color.length > 0
        ? chromaSection.color
        : null;

    const n = typeof section.n === "number" && section.n > 0 ? section.n : 1;

    const { outDir, stem } = outputStemLocation(args.outDir, args.outName ?? defaultStem());
    await ensureOutputDir(outDir);
    const overwrite = args.overwrite ?? false;
    // Reserve before the paid provider edge, so a live overlapping run in this
    // process fails without charging.
    using _outputReservation = await reserveOutputGroup(createOutputGroup(outDir, stem, "json"));
    // Sidecars identify the group independently of the eventual image format.
    assertStemAvailable(outDir, stem, n, overwrite);

    logger.emit("info", "resolve", { event: "verb.start", input: null, output: path.join(outDir, stem), settings: { n, overwrite } });
    logger.emit("info", "request", { event: "provider.call", operation: "generate", model: (params.model as string | undefined) ?? null, settings: { ...params, n } });

    const provider = getProvider();
    const providerResult = await provider.generate({
      prompt,
      params,
      credentials: resolved,
      network: {
        primary: network.imageGenerate,
        download: network.imageDownload,
        logger,
        signal,
      },
    });
    logger.emit("info", "response", { event: "provider.returned", operation: "generate", summary: { images: providerResult.images.length } });

    const requestRecord: GenerateRequestRecord = {
      ...params,
      prompt,
      n,
    };
    if (chromaColor) requestRecord.chroma = { color: chromaColor };
    const { files, failures, leftovers, response } = await publishProviderImages({
      kind: "generate",
      outDir,
      stem,
      n,
      overwrite,
      providerResult,
      requestRecord,
      writer: sidecarWriter(ctx),
      credentials: [resolved.apiKey],
      logger,
    });

    logger.emit("info", "write", { event: "verb.done", output: path.join(outDir, stem), stats: { files: files.length, failures: failures.length, leftovers: leftovers.length } });
    return {
      status: "completed" as const,
      files,
      failures,
      leftovers,
      response,
    };
  });
}
