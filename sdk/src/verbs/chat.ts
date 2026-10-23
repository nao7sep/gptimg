import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "../image/sharp.ts";
import { defaultModelFor } from "../ai-models.ts";
import { callPolicy, requireCredentials, type SdkContext } from "../context.ts";
import { throwIfAborted, fsError, GptImgError } from "../errors.ts";
import { inputImageError } from "../image/bridge.ts";
import { detectFormat } from "../image/detectFormat.ts";
import { hash } from "../image/hash.ts";
import { outputStemLocation, withVerbLogger } from "../internal/local-verb.ts";
import { ensureOutputDir } from "../internal/output-files.ts";
import { assertStemAvailable, createOutputGroup, reserveOutputGroup } from "../internal/output-group.ts";
import { defaultStem } from "../internal/paths.ts";
import { multiline } from "../internal/textCleanup.ts";
import { dispatchHook, type Logger } from "../events/index.ts";
import { diagnosticOf } from "../events/diagnostic.ts";
import { maskDiagnosticCopy } from "../events/mask.ts";
import { resolveNetworkForCall } from "../network/index.ts";
import { checkImageParams, resolveChatModeration, resolveVisionReasoning } from "../policy/model-check.ts";
import { getProvider } from "../providers/index.ts";
import { resolveModel } from "../providers/openai/client.ts";
import { OPENAI_CHAT_INSTRUCTIONS } from "../providers/openai/defaults.ts";
import type { ChatHistoryTurn, ChatImage } from "../providers/types.ts";
import type { RefusedResult } from "../refusal.ts";
import { nullBase64InResponse } from "../sidecar/nullBase64.ts";
import { writeSidecar } from "../sidecar/write.ts";
import { sidecarWriter } from "../sidecar/writer.ts";
import type { ChatArgs, ChatRequestRecord, ChatResult, ChatSidecar, ChatTurn, FilePublication } from "../types.ts";
import { failedPublication, publishProviderImages } from "./image-outputs.ts";
import { usageOf } from "../usage.ts";
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

/**
 * The mask, read and checked against the first image before the paid call: a
 * PNG of the same size that has transparency, since OpenAI changes the image
 * only where the mask is transparent.
 */
async function readMask(filePath: string, first: ChatImage): Promise<ChatImage & { sha256: string; guide: { image: ChatImage; text: string } }> {
  const mask = await readAttachment(filePath);
  const invalid = (message: string, constraint: string) =>
    new GptImgError("args.invalid", `chat: ${message}`, { subject: filePath, details: { field: "mask", constraint } });
  if (mask.format !== "png") throw invalid(`mask must be a PNG, not ${mask.format}.`, "a PNG");
  const [maskInfo, firstInfo] = await Promise.all([sharp(mask.data).metadata(), sharp(first.data).metadata()]);
  if (maskInfo.width !== firstInfo.width || maskInfo.height !== firstInfo.height) {
    throw invalid(
      `mask is ${maskInfo.width}x${maskInfo.height}, but the first image is ${firstInfo.width}x${firstInfo.height}.`,
      "the first image's size",
    );
  }
  if (!maskInfo.hasAlpha) throw invalid("mask has no transparency to mark where the image may change.", "transparency");
  const { data, guide } = await maskForms(mask.data);
  return { ...mask, data, guide };
}

/**
 * The mask in its two forms. For the image tool, as OpenAI documents it: grey
 * equal to its own alpha, so what is kept is opaque white and where the image
 * may change is transparent black. Masking is prompt-based, so the model looks
 * at the mask's colours too, and a mask that was opaque black where nothing
 * should change came back with that area painted black.
 * For the assistant, which writes the image request but is not shown the
 * tool's mask: the same shape opaque, black where the image may change, with
 * the area's bounds in words, so it can say where the change goes.
 */
async function maskForms(png: Uint8Array): Promise<{ data: Uint8Array; guide: { image: ChatImage; text: string } }> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const opaque = Buffer.alloc(width * height * 3);
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const alpha = data[i + 3]!;
    data[i] = alpha;
    data[i + 1] = alpha;
    data[i + 2] = alpha;
    opaque.fill(alpha, p * 3, p * 3 + 3);
    if (alpha < 128) {
      const x = p % width;
      const y = Math.floor(p / width);
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  const percent = (value: number, of: number) => Math.round((value / of) * 100);
  const where =
    right < 0
      ? "nowhere in particular"
      : `from ${percent(left, width)}% to ${percent(right + 1, width)}% across and ${percent(top, height)}% to ${percent(bottom + 1, height)}% down`;
  const tool = new Uint8Array(await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer());
  const guide = new Uint8Array(
    await sharp(opaque, { raw: { width, height, channels: 3 } })
      .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer(),
  );
  return {
    data: tool,
    guide: {
      image: { name: "guide", data: guide, format: "png" },
      text:
        `The last image is the user's mask for the first image, not a picture to use: black marks the area that may change, ` +
        `${where} of the first image measured from its top left; white must stay as it is. Put the requested change inside the black area, ` +
        `and say where it goes when you ask for the image.`,
    },
  };
}

/** An earlier turn's image, fitted for resending; a file that is gone is left out with a warning. */
async function readHistoryImage(filePath: string, logger: Logger): Promise<ChatImage | null> {
  let bytes: Buffer;
  try {
    // Read through Node so a missing file is distinguished by its structured
    // filesystem code, rather than sharp's opaque file-open message.
    bytes = await readFile(filePath);
  } catch (err) {
    const error = fsError(err, "Failed to read history image", filePath);
    if (error.code !== "fs.notFound") throw error;
    logger.emit("warn", "request", { event: "chat.historyImageSkipped", path: filePath, error: diagnosticOf(error) });
    return null;
  }
  try {
    const image = sharp(bytes).resize({ width: HISTORY_IMAGE_MAX_SIDE, height: HISTORY_IMAGE_MAX_SIDE, fit: "inside", withoutEnlargement: true });
    const hasAlpha = (await sharp(bytes).metadata()).hasAlpha;
    const { data, info } = await (hasAlpha ? image.png() : image.jpeg({ quality: 90 })).toBuffer({ resolveWithObject: true });
    const format = hasAlpha ? "png" : "jpeg";
    logger.emit("debug", "request", { event: "chat.historyImage", path: filePath, width: info.width, height: info.height, format });
    return { name: path.basename(filePath), data: new Uint8Array(data), format };
  } catch (err) {
    throw inputImageError(err, "Failed to prepare history image", filePath);
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
 * generates or edits images (OpenAI's Responses API with its image tool), for
 * an app that holds conversations; scripts use generate and edit. The SDK
 * keeps no conversation: the caller passes the earlier turns and the
 * previous turn's `responseId`; while OpenAI holds that response only the new
 * turn is sent, and when it is gone the history is resent. Each image is
 * written into `outDir` with its sidecar, image first; a turn that produced no
 * image writes its record alone as `<stem>.json`, since its answer was paid
 * for too.
 */
/** What a chat turn would send, resolved and checked with no disk, network or key, from checked arguments. */
function planChat(ctx: SdkContext, args: ChatArgs) {
  const policy = callPolicy(ctx, args.policy);
  const section = policy.chat ?? {};
  // The assistant, its effort and the image tool's values are settled and checked before the
  // call, so the events and the records name what is sent.
  const model = resolveModel(section.model, defaultModelFor("openai", "chat"));
  const reasoning = resolveVisionReasoning(model, section.reasoning, "chat");
  const instructions = section.instructions ?? OPENAI_CHAT_INSTRUCTIONS;
  const imageModel = resolveModel(section.imageModel, defaultModelFor("openai", "image-edit"));
  const toolValues = {
    ...(section.size !== undefined && { size: section.size }),
    ...(section.quality !== undefined && { quality: section.quality }),
    ...(section.background !== undefined && { background: section.background }),
    ...(section.output_format !== undefined && { output_format: section.output_format }),
    ...(section.output_compression !== undefined && { output_compression: section.output_compression }),
    ...(section.partial_images !== undefined && section.partial_images > 0 && { partial_images: section.partial_images }),
  };
  checkImageParams("chat", { model: imageModel, ...toolValues });
  const moderation = resolveChatModeration(imageModel);
  const tool = { model: imageModel, ...toolValues, ...(moderation !== undefined && { moderation }) };
  return { policy, model, reasoning, instructions, tool };
}

/** Drafts numbered by the image they belong to, handed to the caller's hook, which can never break the call. */
function partialHandler(opts: VerbCallOptions, format: string) {
  const calls: string[] = [];
  return ({ callId, index, data }: { callId: string; index: number; data: Uint8Array }) => {
    if (!calls.includes(callId)) calls.push(callId);
    dispatchHook(opts.onPartialImage, { image: calls.indexOf(callId), index, data, format });
  };
}

export async function chatImpl(ctx: SdkContext, args: ChatArgs, opts: VerbCallOptions = {}): Promise<ChatResult | RefusedResult> {
  validateChatArgs(args);
  const message = multiline(args.message);

  return withVerbLogger(ctx, "chat", opts, async (logger) => {
    // Checked before the key is asked for, so a wrong value is reported without one.
    const { policy, model, reasoning, instructions, tool } = planChat(ctx, args);
    const credentials = requireCredentials(ctx);
    const network = resolveNetworkForCall(policy);

    const attachments = await Promise.all((args.images ?? []).map(readAttachment));
    const mask = args.mask !== undefined ? await readMask(args.mask, attachments[0]!) : undefined;

    const { outDir, stem } = outputStemLocation(args.outDir, args.outName ?? defaultStem());
    await ensureOutputDir(outDir);
    const overwrite = args.overwrite ?? false;
    // A turn usually makes one image, which its stem names; a conflict found after the call,
    // when the count is known, fails those images as item failures.
    using _outputReservation = await reserveOutputGroup(createOutputGroup(outDir, stem, "json"));
    await assertStemAvailable(outDir, stem, 1, overwrite);
    throwIfAborted(opts.signal);

    logger.emit("info", "resolve", {
      event: "verb.start",
      input: args.images ?? [],
      ...(args.mask !== undefined && { mask: args.mask }),
      output: path.join(outDir, stem),
      settings: { historyTurns: args.history?.length ?? 0, previousResponseId: args.previousResponseId ?? null, overwrite },
    });
    logger.emit("info", "request", { event: "provider.call", operation: "chat", model, settings: { reasoning: reasoning ?? null, tool } });
    const result = await getProvider().chat({
      message,
      images: attachments,
      mask,
      previousResponseId: args.previousResponseId,
      loadHistory: () => loadHistory(args.history ?? [], logger),
      params: { model, reasoning, instructions, tool },
      credentials,
      network: { primary: network.chat, download: network.imageDownload, logger, signal: opts.signal },
      ...(tool.partial_images !== undefined && { onPartialImage: partialHandler(opts, String(tool.output_format ?? "png")) }),
    });
    logger.emit("info", "response", {
      event: "provider.returned",
      operation: "chat",
      summary: { responseId: result.responseId, resumed: result.resumed, images: result.images.length, incomplete: result.incomplete },
    });

    const requestRecord: ChatRequestRecord = {
      model,
      ...(reasoning !== undefined && { reasoning }),
      instructions,
      tool,
      message,
      images: attachments.map(({ name, sha256 }) => ({ name, sha256 })),
      ...(mask && { mask: { name: mask.name, sha256: mask.sha256 } }),
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
    let recordPublication: FilePublication | null = null;
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
        recordPublication = { status: "published" };
      } catch (err) {
        recordPublication = failedPublication(err);
        logger.emit("warn", "write", { event: "sidecar.unpublished", index: null, path: target, error: diagnosticOf(err) });
      }
    }
    logger.emit("info", "write", {
      event: "verb.done",
      output: path.join(outDir, stem),
      stats: { files: published.files.length, failures: published.failures.length, record: recordPath !== null },
    });

    return {
      status: "completed" as const,
      text: result.text,
      files: published.files,
      failures: published.failures,
      leftovers: published.leftovers,
      recordPath,
      recordPublication,
      responseId: result.responseId,
      resumed: result.resumed,
      incomplete: result.incomplete,
      response: published.response,
      usage: usageOf(published.response),
    };
  });
}
