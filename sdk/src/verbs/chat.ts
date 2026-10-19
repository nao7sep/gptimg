import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { defaultModelFor } from "../ai-models.ts";
import { callPolicy, requireCredentials, type SdkContext } from "../context.ts";
import { fsError } from "../errors.ts";
import { detectFormat } from "../image/detectFormat.ts";
import { hash } from "../image/hash.ts";
import { outputStemLocation, withVerbLogger } from "../internal/local-verb.ts";
import { ensureOutputDir } from "../internal/output-files.ts";
import { assertStemAvailable, createOutputGroup, reserveOutputGroup } from "../internal/output-group.ts";
import { defaultStem } from "../internal/paths.ts";
import { multiline } from "../internal/textCleanup.ts";
import type { Logger } from "../log/index.ts";
import { maskDiagnosticCopy } from "../log/mask.ts";
import { resolveNetworkForCall } from "../network/index.ts";
import { checkImageParams, resolveChatModeration, resolveVisionReasoning } from "../policy/model-check.ts";
import { validateChatSection } from "../policy/schemas.ts";
import { getProvider } from "../providers/index.ts";
import { resolveModel } from "../providers/openai/client.ts";
import { OPENAI_CHAT_INSTRUCTIONS } from "../providers/openai/defaults.ts";
import type { ChatHistoryTurn, ChatImage } from "../providers/types.ts";
import type { RefusedResult } from "../refusal.ts";
import { nullBase64InResponse } from "../sidecar/nullBase64.ts";
import { writeSidecar } from "../sidecar/write.ts";
import { sidecarWriter } from "../sidecar/writer.ts";
import type { ChatArgs, ChatRequestRecord, ChatResult, ChatSidecar, ChatTurn } from "../types.ts";
import { publishProviderImages } from "./image-outputs.ts";
import type { VerbCallOptions } from "./options.ts";
import { validateChatArgs } from "./schemas.ts";

// When a conversation has to be resent, the images of its most recent turns go with it, each
// fitted within this many pixels: enough for the assistant to see and refer to them, and a
// request that stays bounded however long the session grew. Older turns are resent as text.
const HISTORY_IMAGE_TURNS = 8;
const HISTORY_IMAGE_MAX_SIDE = 1536;

/** An attached image, read before the paid call so an unreadable one fails first. */
async function readAttachment(filePath: string): Promise<ChatImage & { sha256: string }> {
  let data: Buffer;
  try {
    data = await readFile(filePath);
  } catch (err) {
    throw fsError(err, "Failed to read attached image", filePath);
  }
  const { format } = await detectFormat(data);
  return { name: path.basename(filePath), data: new Uint8Array(data), format, sha256: hash(data) };
}

/** An earlier turn's image, fitted for resending; a file that is gone is left out with a warning. */
async function readHistoryImage(filePath: string, logger: Logger): Promise<ChatImage | null> {
  try {
    const image = sharp(filePath).resize({ width: HISTORY_IMAGE_MAX_SIDE, height: HISTORY_IMAGE_MAX_SIDE, fit: "inside", withoutEnlargement: true });
    const hasAlpha = (await sharp(filePath).metadata()).hasAlpha;
    const data = await (hasAlpha ? image.png() : image.jpeg({ quality: 90 })).toBuffer();
    return { name: path.basename(filePath), data: new Uint8Array(data), format: hasAlpha ? "png" : "jpeg" };
  } catch (err) {
    await logger.warn("request", "an earlier turn's image could not be read and was left out", {
      path: filePath,
      error: (err as Error).message,
    });
    return null;
  }
}

async function loadHistory(history: readonly ChatTurn[], logger: Logger): Promise<ChatHistoryTurn[]> {
  const withImages = history.map((turn, i) => ((turn.images?.length ?? 0) > 0 ? i : -1)).filter((i) => i >= 0);
  const recent = new Set(withImages.slice(-HISTORY_IMAGE_TURNS));
  return Promise.all(
    history.map(async (turn, i) => {
      const paths = recent.has(i) ? (turn.images ?? []) : [];
      const images = (await Promise.all(paths.map((p) => readHistoryImage(p, logger)))).filter((x): x is ChatImage => x !== null);
      return { role: turn.role, text: turn.text, images };
    }),
  );
}

/**
 * One turn of a conversation with an assistant that answers in words and
 * generates or edits images (OpenAI's Responses API with its image tool). The
 * SDK keeps no conversation: the caller passes the earlier turns and the
 * previous turn's `responseId`; while OpenAI holds that response only the new
 * turn is sent, and when it is gone the history is resent. Each image is
 * written into `outDir` with its sidecar, image first; a turn that produced no
 * image writes its record alone as `<stem>.json`, since its answer was paid
 * for too.
 */
export async function chatImpl(ctx: SdkContext, args: ChatArgs, opts: VerbCallOptions = {}): Promise<ChatResult | RefusedResult> {
  validateChatArgs(args);
  const message = multiline(args.message);

  return withVerbLogger(ctx, "chat", opts, async (logger) => {
    const credentials = requireCredentials(ctx);
    const policy = callPolicy(ctx, args.policy);
    const network = resolveNetworkForCall(policy);
    const section = validateChatSection(policy.chat);

    // The assistant, its effort and the image tool's values are settled and checked before the
    // call, so the log and the records name what is sent.
    const model = resolveModel(section.model, defaultModelFor("openai", "chat"));
    const reasoning = resolveVisionReasoning(model, section.reasoning, "chat");
    const instructions = section.instructions ?? OPENAI_CHAT_INSTRUCTIONS;
    const imageModel = section.imageModel ?? defaultModelFor("openai", "image-edit");
    const toolValues = {
      ...(section.size !== undefined && { size: section.size }),
      ...(section.quality !== undefined && { quality: section.quality }),
      ...(section.background !== undefined && { background: section.background }),
      ...(section.output_format !== undefined && { output_format: section.output_format }),
      ...(section.output_compression !== undefined && { output_compression: section.output_compression }),
    };
    checkImageParams("chat", { model: imageModel, ...toolValues });
    const moderation = resolveChatModeration(imageModel);
    const tool = { model: imageModel, ...toolValues, ...(moderation !== undefined && { moderation }) };

    const attachments = await Promise.all((args.images ?? []).map(readAttachment));

    const { outDir, stem } = outputStemLocation(args.outDir, args.outName ?? defaultStem());
    await ensureOutputDir(outDir);
    const overwrite = args.overwrite ?? false;
    // A turn usually makes one image, which its stem names; a conflict found after the call,
    // when the count is known, fails those images as item failures.
    using _outputReservation = await reserveOutputGroup(createOutputGroup(outDir, stem, "json"));
    assertStemAvailable(outDir, stem, 1, overwrite);

    await logger.info("request", "calling provider.chat", {
      model,
      imageModel,
      attachments: attachments.length,
      historyTurns: args.history?.length ?? 0,
      chained: args.previousResponseId !== undefined,
    });
    const result = await getProvider().chat({
      message,
      images: attachments,
      previousResponseId: args.previousResponseId,
      loadHistory: () => loadHistory(args.history ?? [], logger),
      params: { model, reasoning, instructions, tool },
      credentials,
      network: { primary: network.imageGenerate, download: network.imageDownload, logger, signal: opts.signal },
    });
    await logger.info("response", "provider.chat returned", {
      responseId: result.responseId,
      resumed: result.resumed,
      images: result.images.length,
      incomplete: result.incomplete,
    });

    const requestRecord: ChatRequestRecord = {
      model,
      ...(reasoning !== undefined && { reasoning }),
      instructions,
      tool,
      message,
      images: attachments.map(({ name, sha256 }) => ({ name, sha256 })),
      previousResponseId: result.resumed === "chain" ? (args.previousResponseId ?? null) : null,
      historyTurns: result.historyTurns,
    };
    const published = await publishProviderImages({
      kind: "chat",
      outDir,
      stem,
      n: result.images.length,
      overwrite,
      providerResult: result,
      requestRecord,
      writer: sidecarWriter(ctx),
      credentials: [credentials.apiKey],
      logger,
    });

    // With no image published, the turn's paid answer is kept beside nothing: `<stem>.json`.
    let recordPath: string | null = null;
    if (published.files.length === 0) {
      const record = maskDiagnosticCopy({
        formatVersion: 2,
        kind: "chat",
        writer: sidecarWriter(ctx),
        request: requestRecord,
        response: nullBase64InResponse(result.raw),
        files: [],
      }, [credentials.apiKey]) as ChatSidecar;
      const target = path.join(outDir, `${stem}.json`);
      try {
        await writeSidecar(target, record, { overwrite });
        recordPath = target;
      } catch (err) {
        await logger.warn("write", "the turn's record could not be written; the result still carries its response", {
          path: target,
          error: (err as Error).message,
        });
      }
    }

    return {
      status: "completed" as const,
      text: result.text,
      files: published.files,
      failures: published.failures,
      leftovers: published.leftovers,
      recordPath,
      responseId: result.responseId,
      resumed: result.resumed,
      incomplete: result.incomplete,
      response: published.response,
      logPath: logger.handle.path,
    };
  });
}
