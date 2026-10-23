// Main's side of the SDK's utility process: started on first use, started
// again after it exits, each call settled exactly once. A call in flight when
// the process dies settles as a lost-worker failure with an unknown effect,
// since the provider may already have done the work.
import { randomUUID } from "node:crypto";
import { utilityProcess, type UtilityProcess } from "electron";
import type { PartialDraft, SdkOp, WorkerReply, WorkerRequest } from "./sdk-protocol.ts";

export type CallSettlement =
  | { kind: "result"; result: Record<string, unknown> }
  | { kind: "error"; error: Record<string, unknown> }
  | { kind: "lost" };

interface Pending {
  onEvent: (event: Record<string, unknown>) => void;
  onProgress: (progress: Record<string, unknown>) => void;
  onPartial: (partial: PartialDraft) => void;
  settle: (settlement: CallSettlement) => void;
}

export interface CallHooks {
  apiKey?: string | null;
  baseURL?: string | null;
  onEvent?: (event: Record<string, unknown>) => void;
  onProgress?: (progress: Record<string, unknown>) => void;
  onPartial?: (partial: PartialDraft) => void;
}

const WORKER_WAIT_MS = 30_000;

export class SdkHost {
  #child: UtilityProcess | null = null;
  #ready: Promise<void> | null = null;
  #stopping = false;
  #usable = false;
  #failed = false;
  #exit: Promise<void> | null = null;
  readonly #pending = new Map<string, Pending>();

  readonly #entry: string;
  readonly #onExit: (code: number) => void;

  constructor(entry: string, onExit: (code: number) => void) {
    this.#entry = entry;
    this.#onExit = onExit;
  }

  #losePending(): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.settle({ kind: "lost" });
    }
  }

  #start(): Promise<void> {
    if (this.#ready) return this.#ready;
    let child: UtilityProcess;
    try {
      child = utilityProcess.fork(this.#entry, [], { serviceName: "GptImg SDK", stdio: "inherit" });
    } catch {
      this.#losePending();
      return Promise.resolve();
    }
    this.#child = child;
    this.#usable = false;
    this.#failed = false;
    this.#stopping = false;
    let resolveExit!: () => void;
    this.#exit = new Promise((resolve) => { resolveExit = resolve; });
    this.#ready = new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.#child !== child) return;
        this.#failed = true;
        this.#losePending();
        resolve();
        child.kill();
      }, WORKER_WAIT_MS);
      child.on("message", (reply: WorkerReply) => {
        if (this.#child !== child || this.#failed || this.#stopping) return;
        if (reply.type === "ready") {
          clearTimeout(timer);
          this.#usable = true;
          resolve();
          return;
        }
        if (!this.#usable) return;
        const pending = this.#pending.get(reply.id);
        if (!pending) return;
        if (reply.type === "event") pending.onEvent(reply.event);
        else if (reply.type === "progress") pending.onProgress(reply.progress);
        else if (reply.type === "partial") pending.onPartial(reply.partial);
        else {
          this.#pending.delete(reply.id);
          pending.settle(reply.type === "result" ? { kind: "result", result: reply.result } : { kind: "error", error: reply.error });
        }
      });
      child.once("exit", (code) => {
        if (this.#child !== child) return;
        clearTimeout(timer);
        const expected = this.#stopping;
        this.#child = null;
        this.#ready = null;
        this.#exit = null;
        this.#usable = false;
        this.#stopping = false;
        resolve();
        resolveExit();
        this.#losePending();
        // An exit the app requested does not need another failure notice.
        if (!expected) this.#onExit(code);
      });
    });
    return this.#ready;
  }

  /** Runs one SDK operation; `cancel` is returned at once so the caller can abort while it runs. */
  call(
    op: SdkOp,
    app: { name: string; version: string },
    args: Record<string, unknown>,
    hooks: CallHooks = {},
  ): { id: string; done: Promise<CallSettlement>; cancel: () => void } {
    const id = randomUUID();
    let sent = false;
    if (this.#stopping) return { id, done: Promise.resolve({ kind: "lost" }), cancel: () => {} };
    const done = new Promise<CallSettlement>((settle) => {
      this.#pending.set(id, { onEvent: hooks.onEvent ?? (() => {}), onProgress: hooks.onProgress ?? (() => {}), onPartial: hooks.onPartial ?? (() => {}), settle });
      void this.#start().then(() => {
        if (!this.#pending.has(id)) return;
        if (!this.#child || !this.#usable || this.#stopping) {
          this.#pending.delete(id);
          settle({ kind: "lost" });
          return;
        }
        sent = true;
        this.#post({ type: "call", id, op, apiKey: hooks.apiKey ?? null, baseURL: hooks.baseURL ?? null, app, args });
      });
    });
    return {
      id,
      done,
      cancel: () => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        if (sent) this.#post({ type: "cancel", id });
        else {
          this.#pending.delete(id);
          pending.settle({ kind: "error", error: {
            name: "GptImgError", code: "cancelled", kind: "cancelled", effect: "none", message: "Cancelled before the worker call was sent.",
          } });
        }
      },
    };
  }

  /** One chat turn, billed to `apiKey`, sent to `baseURL` (OpenAI's own when null). */
  chat(
    apiKey: string,
    baseURL: string | null,
    app: { name: string; version: string },
    args: Record<string, unknown>,
    hooks: Pick<CallHooks, "onEvent" | "onPartial">,
  ): { id: string; done: Promise<CallSettlement>; cancel: () => void } {
    return this.call("chat", app, args, { apiKey, baseURL, ...hooks });
  }

  #post(request: WorkerRequest): void {
    const child = this.#child;
    if (!child) return;
    try {
      child.postMessage(request);
    } catch {
      // A broken channel must not leave an unhandled dispatch rejection or
      // allow more paid work onto this worker. Keep it owned until its exit.
      this.#usable = false;
      this.#failed = true;
      const pending = this.#pending.get(request.id);
      this.#pending.delete(request.id);
      pending?.settle({ kind: "lost" });
      child.kill();
    }
  }

  /** Wait for the owned worker to exit before allowing another to start. */
  async restart(): Promise<void> {
    const child = this.#child;
    const exited = this.#exit;
    if (!child || !exited) return;
    this.#stopping = true;
    this.#usable = false;
    child.kill();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("The SDK worker did not exit within 30 seconds.")), WORKER_WAIT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  stop(): void {
    if (!this.#child) return;
    this.#stopping = true;
    this.#usable = false;
    this.#child.kill();
  }
}
