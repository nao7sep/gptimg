import type { RefusedResult } from "../refusal.ts";
import { callPolicy, requireCredentials, type SdkContext } from "../context.ts";
import { sidecarWriter } from "../sidecar/writer.ts";
import { defaultModelFor } from "../ai-models.ts";
import { resolveModel } from "../providers/openai/client.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fsError } from "../errors.ts";
import { hash } from "../image/hash.ts";
import { ensureOutputDir } from "../internal/output-files.ts";
import {
  reserveOutputGroup,
  assertStemAvailable,
  createOutputGroup,
} from "../internal/output-group.ts";
import { outputStemLocation, withVerbLogger } from "../internal/local-verb.ts";
import { multiline } from "../internal/textCleanup.ts";
import { resolveNetworkForCall } from "../network/index.ts";
import { checkImageParams } from "../policy/model-check.ts";
import { validateEditSection } from "../policy/schemas.ts";
import { getProvider } from "../providers/index.ts";
import type { EditArgs, EditResult } from "../types.ts";
import type { VerbCallOptions } from "./options.ts";
import { publishProviderImages } from "./image-outputs.ts";
import { validateEditArgs } from "./schemas.ts";
import { defaultStem } from "../internal/paths.ts";

export type EditContext = SdkContext;

/**
 * Read an input image before the paid call, failing early when it is
 * unreadable, and return its SHA-256 so the sidecar identifies the exact
 * source after a rename or overwrite, as it identifies each output.
 */
async function readImageSha256(filePath: string, label: string): Promise<string> {
  try {
    return hash(await readFile(filePath));
  } catch (err) {
    throw fsError(err, `Failed to read ${label} image`, filePath);
  }
}

export async function editImpl(
  ctx: EditContext,
  args: EditArgs,
  opts: VerbCallOptions = {},
): Promise<EditResult | RefusedResult> {
  validateEditArgs(args);
  const signal = opts.signal;
  // Normalize the free-text prompt once, at the input boundary, so the same
  // cleaned value is both sent to the provider and stored in the sidecar.
  // multiline() is content-preserving (drops only edge blank lines and per-line
  // trailing whitespace), so it is safe for the outgoing request.
  const prompt = multiline(args.prompt);

  return withVerbLogger(ctx, "edit", opts, async (logger) => {
    const resolved = requireCredentials(ctx);
    await logger.info("resolve", "apiKey resolved", {
      apiKeySource: resolved.apiKeySource,
      provider: resolved.redacted.provider,
    });

    const policy = callPolicy(ctx, args.policy);
    const network = resolveNetworkForCall(policy);
    const section = validateEditSection(policy.edit);
    // The model is settled and its values checked before the call, so the log and the sidecar
    // name what is sent.
    const params: Record<string, unknown> = {
      ...section,
      model: resolveModel(section.model, defaultModelFor("openai", "image-edit")),
    };
    checkImageParams("edit", params);

    const n =
      typeof params.n === "number" && (params.n as number) > 0
        ? (params.n as number)
        : 1;

    const inputSha256 = await readImageSha256(args.in, "input");
    const maskSha256 = args.mask ? await readImageSha256(args.mask, "mask") : null;

    const { outDir, stem } = outputStemLocation(args.outDir ?? path.dirname(args.in), args.outName ?? defaultStem());
    await ensureOutputDir(outDir);
    const overwrite = args.overwrite ?? false;
    using _outputReservation = await reserveOutputGroup(createOutputGroup(outDir, stem, "json"));
    // Fail before the paid provider call when this stem already conflicts.
    assertStemAvailable(outDir, stem, n, overwrite);

    await logger.info("request", "calling provider.edit", {
      provider: resolved.redacted.provider,
      model: params.model ?? null,
      input: path.basename(args.in),
      mask: args.mask ? path.basename(args.mask) : null,
      n,
    });

    const provider = getProvider(resolved.redacted.provider);
    const providerResult = await provider.edit({
      prompt,
      imagePath: args.in,
      maskPath: args.mask,
      params,
      profile: resolved,
      network: {
        primary: network.imageGenerate,
        download: network.imageDownload,
        logger,
        signal,
      },
    });
    await logger.info("response", "provider.edit returned", {
      itemCount: providerResult.images.length,
    });

    const requestRecord = {
      ...params,
      prompt,
      input: path.basename(args.in),
      inputSha256,
      mask: args.mask ? path.basename(args.mask) : null,
      maskSha256,
      n,
    };
    const { files, failures, leftovers, response } = await publishProviderImages({
      kind: "edit",
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

    return {
      status: "completed" as const,
      files,
      failures,
      leftovers,
      response,
      logPath: logger.handle.path,
    };
  });
}
