// One turn of a session: the user's message is saved first, so it survives a
// failed or cancelled call; the SDK's chat runs in the utility process; the
// reply's text and images are saved as the assistant turn. One turn runs per
// session at a time.
import { randomUUID } from "node:crypto";
import { relative, sep } from "node:path";
import type { ChatResult, GptImgErrorData, RefusedResult } from "gptimgsdk/types";
import type { AppFailure, OpenedSession, SendRequest, TurnOutcome } from "../shared/api.ts";
import { failureFromError, failureFromRefusal, lostWorkerFailure } from "../shared/failures.ts";
import { message } from "../shared/i18n/translator.ts";
import {
  fileStamp,
  historyBefore,
  previousResponseBefore,
  titleFrom,
  usageOf,
  type AssistantTurn,
  type SessionDoc,
  type UserTurn,
} from "../shared/session.ts";
import { effectiveThinking, type Settings } from "../shared/settings.ts";
import type { Records } from "./records.ts";
import type { CallSettlement, SdkHost } from "./sdk-host.ts";
import { createSession, importReference, readSession, sessionDir, writeSession } from "./sessions.ts";

export interface TurnDeps {
  host: SdkHost;
  records: Records;
  settings: () => Settings;
  apiKey: () => Promise<string | null>;
  app: { name: string; version: string };
  backup: (path: string, text: string) => void;
  /** Called once a staged (pasted) file has been copied into a session. */
  releaseStaged: (path: string) => void;
  /** The user's turn is saved; the call is about to start. */
  started: (requestId: string, session: OpenedSession) => void;
  now?: () => Date;
}

function plain(failure: AppFailure, session: OpenedSession | null, cancelled = false): TurnOutcome {
  return { ok: false, session, failure, cancelled };
}

export class TurnRunner {
  readonly #running = new Map<string, () => void>();

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

  cancel(sessionId: string): void {
    this.#running.get(sessionId)?.();
  }

  cancelAll(): void {
    for (const cancel of this.#running.values()) cancel();
  }

  #now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async #save(root: string, id: string, doc: SessionDoc): Promise<void> {
    const text = await writeSession(root, id, doc);
    if (text) this.deps.backup(`${sessionDir(root, id)}${sep}session.json`, text);
  }

  async send(request: SendRequest): Promise<TurnOutcome> {
    const settings = this.deps.settings();
    const root = settings.sessionsDir;
    if (!root) return plain({ message: message("failure.noSessionsFolder"), retryable: false }, null);
    const apiKey = await this.deps.apiKey();
    if (!apiKey) return plain({ message: message("failure.apiKeyMissing"), retryable: false }, null);
    if (request.sessionId && this.isRunning(request.sessionId)) {
      return plain({ message: message("failure.turnRunning"), retryable: false }, null);
    }

    const now = this.#now();
    let id: string;
    let doc: SessionDoc;
    try {
      if (request.sessionId) {
        id = request.sessionId;
        doc = await readSession(root, id);
      } else {
        ({ id, doc } = await createSession(root, now, titleFrom(request.text)));
      }
      const dir = sessionDir(root, id);
      const images: string[] = [];
      for (const reference of request.references) {
        const isAbsolute = reference.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(reference);
        images.push(isAbsolute ? await importReference(dir, reference, now) : reference);
        if (isAbsolute) this.deps.releaseStaged(reference);
      }
      const turn: UserTurn = { id: randomUUID(), role: "user", at: now.toISOString(), text: request.text, images, options: request.options };
      doc = { ...doc, turns: [...doc.turns, turn] };
      await this.#save(root, id, doc);
    } catch (error) {
      this.deps.records.log("error", "turn.saveFailed", { error: String(error) });
      return plain({ message: message("failure.sessionWrite"), retryable: false }, null);
    }
    this.deps.started(request.requestId, { id, doc, dir: sessionDir(root, id) });
    return this.#run(root, id, doc, apiKey, settings);
  }

  async retry(sessionId: string): Promise<TurnOutcome> {
    const settings = this.deps.settings();
    const root = settings.sessionsDir;
    const apiKey = await this.deps.apiKey();
    if (!apiKey) return plain({ message: message("failure.apiKeyMissing"), retryable: false }, null);
    if (this.isRunning(sessionId)) return plain({ message: message("failure.turnRunning"), retryable: false }, null);
    let doc: SessionDoc;
    try {
      doc = await readSession(root, sessionId);
    } catch {
      return plain({ message: message("failure.sessionRead"), retryable: false }, null);
    }
    if (doc.turns[doc.turns.length - 1]?.role !== "user") {
      return plain({ message: message("failure.nothingToRetry"), retryable: false }, { id: sessionId, doc, dir: sessionDir(root, sessionId) });
    }
    return this.#run(root, sessionId, doc, apiKey, settings);
  }

  /** Sends the session's last turn, which is the user's, and saves the reply. */
  async #run(root: string, id: string, doc: SessionDoc, apiKey: string, settings: Settings): Promise<TurnOutcome> {
    const dir = sessionDir(root, id);
    const index = doc.turns.length - 1;
    const turn = doc.turns[index] as UserTurn;
    const absolute = (rel: string) => `${dir}${sep}${rel.split("/").join(sep)}`;
    const reasoning = effectiveThinking(settings);
    const previousResponseId = previousResponseBefore(doc.turns, index);
    const args = {
      message: turn.text,
      ...(turn.images.length > 0 && { images: turn.images.map(absolute) }),
      history: historyBefore(doc.turns, index, absolute),
      ...(previousResponseId && { previousResponseId }),
      outDir: dir,
      outName: fileStamp(this.#now()),
      policy: {
        chat: {
          model: settings["openai.chat"],
          ...(reasoning && { reasoning }),
          imageModel: settings["openai.image"],
          size: turn.options.size,
          quality: turn.options.quality,
        },
      },
    };

    const call = this.deps.host.chat(apiKey, this.deps.app, args, (event) => this.deps.records.sdkEvent(id, event));
    let cancelled = false;
    this.#running.set(id, () => {
      cancelled = true;
      call.cancel();
    });
    let settlement: CallSettlement;
    try {
      settlement = await call.done;
    } finally {
      this.#running.delete(id);
    }
    const opened = (d: SessionDoc): OpenedSession => ({ id, doc: d, dir });
    const model = settings["openai.chat"];

    if (settlement.kind === "lost") {
      this.deps.records.turn({ sessionFolder: id, turnId: turn.id, model, status: "failed", responseId: null, inputTokens: null, outputTokens: null, body: { lost: true } });
      return plain(lostWorkerFailure(), opened(doc));
    }
    if (settlement.kind === "error") {
      const error = settlement.error as unknown as GptImgErrorData;
      const status = error.code === "cancelled" ? "cancelled" : "failed";
      this.deps.records.turn({ sessionFolder: id, turnId: turn.id, model, status, responseId: null, inputTokens: null, outputTokens: null, body: error });
      return plain(failureFromError(error), opened(doc), cancelled || error.code === "cancelled");
    }
    const result = settlement.result as unknown as ChatResult | RefusedResult;
    if (result.status === "refused") {
      const usage = result.response ? usageOf(result.response) : null;
      this.deps.records.turn({
        sessionFolder: id,
        turnId: turn.id,
        model,
        status: "refused",
        responseId: typeof result.response?.id === "string" ? result.response.id : null,
        inputTokens: usage?.input ?? null,
        outputTokens: usage?.output ?? null,
        body: { refusal: result.refusal, response: result.response ?? null },
      });
      return plain(failureFromRefusal(result.refusal), opened(doc));
    }

    const usage = usageOf(result.response);
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
      failedImages: result.failures.length,
    };
    this.deps.records.turn({
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
    let latest = doc;
    try {
      latest = await readSession(root, id);
    } catch {
      // Fall back to what this turn started from.
    }
    const next = { ...latest, turns: [...latest.turns, reply] };
    try {
      await this.#save(root, id, next);
    } catch (error) {
      this.deps.records.log("error", "turn.replySaveFailed", { error: String(error), responseId: result.responseId });
      return plain({ message: message("failure.sessionWrite"), retryable: false }, opened(latest));
    }
    return { ok: true, session: opened(next) };
  }
}
