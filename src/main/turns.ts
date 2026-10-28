// One turn of a session: the user's message is saved first, so it survives a
// failed or cancelled call; the SDK's chat runs in the utility process; the
// reply's text and images are saved as the assistant turn. One turn runs per
// session at a time.
import { randomUUID } from "node:crypto";
import { join, relative, sep } from "node:path";
import type { ChatResult, RefusedResult } from "gptimgsdk/types";
import type { AppFailure, OpenedSession, SendRequest, TurnOutcome } from "../shared/api.ts";
import { errorDataOf, failureFromError, failureFromRefusal, lostWorkerFailure } from "../shared/failures.ts";
import { message } from "../shared/i18n/translator.ts";
import {
  backgroundOf,
  chatIdOf,
  fileStamp,
  historyBefore,
  previousResponseBefore,
  titleFrom,
  type AssistantTurn,
  type SessionDoc,
  type UserTurn,
} from "../shared/session.ts";
import { effectiveThinking, modelSpelling, OPENAI_ENDPOINT, type Settings } from "../shared/settings.ts";
import type { Records } from "./records.ts";
import type { CallSettlement, SdkHost } from "./sdk-host.ts";
import type { PartialDraft } from "./sdk-protocol.ts";
import { createSession, importReference, isInside, readSession, SessionError, sessionDir, withId, writeSession } from "./sessions.ts";

export interface TurnDeps {
  host: SdkHost;
  records: Records;
  settings: () => Settings;
  apiKey: () => Promise<string | null>;
  authorizeImage?: (path: string) => boolean;
  app: { name: string; version: string };
  backup: (path: string, text: string) => void;
  /** Called after the saved user turn owns its imported staged file. */
  releaseStaged: (path: string) => void;
  /** The user's turn is saved; the call is about to start. */
  started: (requestId: string, session: OpenedSession) => void;
  /** A draft of an image the session's turn is drawing; `null` once the turn settles. */
  draft?: (sessionId: string, draft: PartialDraft | null) => void;
  now?: () => Date;
}

/** What GptImg's assistant is told, sent with every turn: GptImg's own product text, not the SDK's. */
export const CHAT_INSTRUCTIONS =
  "You help the user create and refine images. When they ask for an image or a change to one, use the image generation tool; otherwise answer briefly. Reply in the language the user writes in. When a request is ambiguous, make a reasonable choice and say what you chose rather than asking first.";

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path);
}

function plain(failure: AppFailure, session: OpenedSession | null, cancelled = false): TurnOutcome {
  return { ok: false, session, failure, cancelled };
}

type TurnOperation = { cancelled: boolean; cancel?: () => void; keys: Set<string>; sessionId?: string; done?: Promise<TurnOutcome> };

export class TurnRunner {
  readonly #running = new Map<string, TurnOperation>();

  readonly deps: TurnDeps;

  constructor(deps: TurnDeps) {
    this.deps = deps;
  }

  isRunning(sessionId: string): boolean {
    return this.#running.has(sessionId);
  }

  get busy(): boolean {
    return this.#running.size > 0;
  }

  /** Hold a session through a rename or trash operation, before its first wait. */
  reserveSession(id: string): (() => void) | null {
    if (this.#running.has(id)) return null;
    this.#running.set(id, { cancelled: false, keys: new Set([id]) });
    let reserved = true;
    return () => {
      if (!reserved) return;
      reserved = false;
      this.#running.delete(id);
    };
  }

  cancel(sessionId: string): void {
    const operation = this.#running.get(sessionId);
    if (operation) { operation.cancelled = true; operation.cancel?.(); }
  }

  /** Cancels every running turn; settles once each has recorded its outcome. */
  cancelAll(): Promise<void> {
    const settling = new Set<Promise<TurnOutcome>>();
    for (const [key, operation] of this.#running) {
      this.cancel(key);
      if (operation.done) settling.add(operation.done);
    }
    return Promise.all(settling).then(() => undefined);
  }

  #now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async #save(root: string, id: string, doc: SessionDoc): Promise<void> {
    const text = await writeSession(root, id, doc);
    if (text) this.deps.backup(`${sessionDir(root, id)}${sep}session.json`, text);
  }

  #own(key: string, run: (operation: TurnOperation) => Promise<TurnOutcome>): Promise<TurnOutcome> {
    if (this.isRunning(key)) return Promise.resolve(plain({ message: message("failure.turnRunning"), retryable: false }, null));
    const operation: TurnOperation = { cancelled: false, keys: new Set([key]) };
    this.#running.set(key, operation);
    operation.done = (async () => {
      try {
        return await run(operation);
      } catch (error) {
        this.deps.records.log("error", "turn.failed", { error: String(error) });
        return plain(failureFromError(errorDataOf(error)), null);
      } finally {
        for (const owned of operation.keys) {
          this.#running.delete(owned);
        }
        if (operation.sessionId) this.deps.draft?.(operation.sessionId, null);
      }
    })();
    return operation.done;
  }

  async send(request: SendRequest): Promise<TurnOutcome> {
    if (!request.text.trim()) return plain({ message: message("failure.invalidRequest"), retryable: false }, null);
    return this.#own(request.sessionId ?? request.requestId, (operation) => this.#send(request, operation));
  }

  async #send(request: SendRequest, operation: TurnOperation): Promise<TurnOutcome> {
    const settings = this.deps.settings();
    const root = settings.sessionsDir;
    if (!root) return plain({ message: message("failure.noSessionsFolder"), retryable: false }, null);
    const apiKey = await this.deps.apiKey();
    if (!apiKey) return plain({ message: message("failure.apiKeyMissing"), retryable: false }, null);
    if (operation.cancelled) return plain({ message: message("failure.cancelled"), retryable: false }, null, true);

    const external = request.references.filter(isAbsolutePath);
    if (request.mask) external.push(request.mask.mask);
    for (const path of external) {
      if (this.deps.authorizeImage && !this.deps.authorizeImage(path)) return plain({ message: message("failure.imageMissing"), retryable: false }, null);
      if (operation.cancelled) return plain({ message: message("failure.cancelled"), retryable: false }, null, true);
    }

    const now = this.#now();
    let id: string;
    let doc: SessionDoc;
    let recoveryPath: string | undefined;
    try {
      if (request.sessionId) {
        id = request.sessionId;
        doc = withId(await readSession(root, id));
      } else {
        ({ id, doc } = await createSession(root, now, titleFrom(request.text)));
        this.deps.records.log("info", "sessions.created", { chatId: chatIdOf(id, doc), folder: id });
      }
      operation.keys.add(id);
      this.#running.set(id, operation);
      const dir = sessionDir(root, id);
      recoveryPath = dir;
      const images: string[] = [];
      // The masked image goes first: a mask applies to the first image a message carries.
      const masked = request.mask && request.references.includes(request.mask.image) ? request.mask : undefined;
      const references = masked ? [masked.image, ...request.references.filter((r) => r !== masked.image)] : request.references;
      for (const reference of references) {
        if (operation.cancelled) return plain({ message: message("failure.cancelled"), retryable: false }, null, true);
        if (!isAbsolutePath(reference) && !isInside(dir, join(dir, reference))) throw new SessionError("badId", reference);
        images.push(isAbsolutePath(reference) ? await importReference(dir, reference, now) : reference);
      }
      let mask: string | undefined;
      if (masked) {
        mask = await importReference(dir, masked.mask, now);

      }
      const turn: UserTurn = {
        id: randomUUID(),
        role: "user",
        at: now.toISOString(),
        text: request.text,
        images,
        ...(mask && { mask }),
        options: request.options,
      };
      doc = { ...doc, turns: [...doc.turns, turn] };
      if (operation.cancelled) return plain({ message: message("failure.cancelled"), retryable: false }, null, true);
      await this.#save(root, id, doc);
      for (const reference of references) if (isAbsolutePath(reference)) this.deps.releaseStaged(reference);
      if (masked) this.deps.releaseStaged(masked.mask);
      this.deps.records.log("info", "turn.sent", { chatId: chatIdOf(id, doc), turnId: turn.id, attachments: images.length, masked: mask !== undefined, options: turn.options });
    } catch (error) {
      this.deps.records.log("error", "turn.saveFailed", { error: String(error) });
      return plain({ message: message("failure.sessionWrite"), retryable: false, ...(recoveryPath && { recoveryPath }) }, null);
    }
    this.deps.started(request.requestId, { id, doc, dir: sessionDir(root, id) });
    return this.#run(root, id, doc, apiKey, settings, operation);
  }

  async retry(sessionId: string): Promise<TurnOutcome> {
    return this.#own(sessionId, (operation) => this.#retry(sessionId, operation));
  }

  async #retry(sessionId: string, operation: TurnOperation): Promise<TurnOutcome> {
    const settings = this.deps.settings();
    const root = settings.sessionsDir;
    const apiKey = await this.deps.apiKey();
    if (!apiKey) return plain({ message: message("failure.apiKeyMissing"), retryable: false }, null);

    let doc: SessionDoc;
    try {
      doc = withId(await readSession(root, sessionId));
    } catch {
      return plain({ message: message("failure.sessionRead"), retryable: false }, null);
    }
    if (doc.turns[doc.turns.length - 1]?.role !== "user") {
      return plain({ message: message("failure.nothingToRetry"), retryable: false }, { id: sessionId, doc, dir: sessionDir(root, sessionId) });
    }
    return this.#run(root, sessionId, doc, apiKey, settings, operation);
  }

  /** Sends the session's last turn, which is the user's, and saves the reply. */
  async #run(root: string, id: string, doc: SessionDoc, apiKey: string, settings: Settings, operation: TurnOperation): Promise<TurnOutcome> {
    const dir = sessionDir(root, id);
    operation.sessionId = id;
    const index = doc.turns.length - 1;
    const turn = doc.turns[index] as UserTurn;
    const absolute = (rel: string) => `${dir}${sep}${rel.split("/").join(sep)}`;
    const opened = (d: SessionDoc): OpenedSession => ({ id, doc: d, dir });
    if (operation.cancelled) return plain({ message: message("failure.cancelled"), retryable: false }, opened(doc), true);
    const reasoning = effectiveThinking(settings);
    const previousResponseId = previousResponseBefore(doc.turns, index);
    const args = {
      message: turn.text,
      ...(turn.images.length > 0 && { images: turn.images.map(absolute) }),
      ...(turn.mask && turn.images.length > 0 && { mask: absolute(turn.mask) }),
      history: historyBefore(doc.turns, index, absolute),
      ...(previousResponseId && { previousResponseId }),
      outDir: dir,
      // The reply's position in the chat keeps two turns in one second apart; the stamp keeps a retry apart from an earlier attempt.
      outName: `${fileStamp(this.#now())}-t${index + 2}`,
      policy: {
        chat: {
          model: modelSpelling(settings["openai.chat"]),
          instructions: CHAT_INSTRUCTIONS,
          ...(reasoning && { reasoning }),
          imageModel: modelSpelling(settings["openai.image"]),
          size: turn.options.size,
          quality: turn.options.quality,
          ...(backgroundOf(turn.options) !== "auto" && { background: backgroundOf(turn.options) }),
          ...(settings["openai.drafts"] > 0 && { partial_images: settings["openai.drafts"] }),
        },
      },
    };

    const endpoint = settings["openai.endpoint"].trim();
    const chat = { id: chatIdOf(id, doc), folder: id };
    const call = this.deps.host.chat(apiKey, endpoint === OPENAI_ENDPOINT ? null : endpoint, this.deps.app, args, {
      onEvent: (event) => this.deps.records.sdkEvent(chat, event),
      onPartial: (draft) => this.deps.draft?.(id, draft),
    });
    operation.cancel = call.cancel;
    if (operation.cancelled) call.cancel();
    const settlement: CallSettlement = await call.done;
    const model = settings["openai.chat"];

    if (settlement.kind === "lost") {
      this.deps.records.turn({ chatId: chat.id, sessionFolder: id, turnId: turn.id, model, status: "failed", responseId: null, inputTokens: null, outputTokens: null, body: { lost: true } });
      this.deps.records.log("error", "turn.failed", { chatId: chat.id, turnId: turn.id, reason: "workerLost" });
      return plain(lostWorkerFailure(), opened(doc));
    }
    if (settlement.kind === "error") {
      const error = errorDataOf(settlement.error);
      const status = error.code === "cancelled" ? "cancelled" : "failed";
      this.deps.records.turn({ chatId: chat.id, sessionFolder: id, turnId: turn.id, model, status, responseId: null, inputTokens: null, outputTokens: null, body: error });
      this.deps.records.log(status === "cancelled" ? "info" : "warn", status === "cancelled" ? "turn.cancelled" : "turn.failed", { chatId: chat.id, turnId: turn.id, code: error.code });
      return plain(failureFromError(error), opened(doc), operation.cancelled || error.code === "cancelled");
    }
    const result = settlement.result as unknown as ChatResult | RefusedResult;
    if (result.status === "refused") {
      const usage = result.usage ?? null;
      this.deps.records.log("warn", "turn.failed", { chatId: chat.id, turnId: turn.id, refusal: result.refusal.code });
      this.deps.records.turn({
        chatId: chat.id,
        sessionFolder: id,
        turnId: turn.id,
        model,
        status: "refused",
        responseId: result.responseId ?? null,
        inputTokens: usage?.input ?? null,
        outputTokens: usage?.output ?? null,
        body: { refusal: result.refusal, response: result.response ?? null },
      });
      return plain(failureFromRefusal(result.refusal), opened(doc));
    }

    const usage = result.usage;
    const reply: AssistantTurn = {
      id: randomUUID(),
      role: "assistant",
      at: this.#now().toISOString(),
      text: result.text,
      images: result.files.map((file) => relative(dir, file.path).split(sep).join("/")),
      responseId: result.responseId,
      resumed: result.resumed,
      incomplete: result.incomplete,
      usage,
      ...imageFailures(result.failures),
    };
    this.deps.records.log("info", "turn.replied", { chatId: chat.id, turnId: reply.id, images: reply.images.length, usage, resumed: reply.resumed });
    this.deps.records.turn({
      chatId: chat.id,
      sessionFolder: id,
      turnId: reply.id,
      model,
      status: "completed",
      responseId: result.responseId,
      inputTokens: usage?.input ?? null,
      outputTokens: usage?.output ?? null,
      body: result.response,
    });
    // Re-read before appending: a rename may not run meanwhile, but the file is the authority.
    let next: SessionDoc;
    try {
      const latest = withId(await readSession(root, id));
      if (latest.id !== doc.id || JSON.stringify(latest.turns) !== JSON.stringify(doc.turns)) throw new Error("The conversation changed while its reply was being prepared.");
      next = { ...latest, turns: [...latest.turns, reply] };
      await this.#save(root, id, next);
    } catch (error) {
      this.deps.records.log("error", "turn.replySaveFailed", { error: String(error), responseId: result.responseId });
      // Keep the paid reply visible for recovery; no stale snapshot is written over the authoritative file.
      return plain({ message: message("failure.sessionWrite"), retryable: false, recoveryPath: dir }, opened({ ...doc, turns: [...doc.turns, reply] }));
    }
    return { ok: true, session: opened(next) };
  }
}

/** A turn's image failures by what happened: blocked by moderation, never returned, or returned but not saved. */
function imageFailures(failures: readonly { code: string }[]): Pick<AssistantTurn, "failedImages" | "blockedImages" | "missingImages"> {
  const blocked = failures.filter((f) => f.code === "provider.moderationBlocked").length;
  const missing = failures.filter((f) => f.code === "provider.noImage").length;
  return { failedImages: failures.length - blocked - missing, ...(blocked > 0 && { blockedImages: blocked }), ...(missing > 0 && { missingImages: missing }) };
}
