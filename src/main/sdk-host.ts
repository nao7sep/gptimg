// Main's side of the SDK's utility process: started on first use, started
// again after it exits, each call settled exactly once. A call in flight when
// the process dies settles as a lost-worker failure with an unknown effect,
// since the provider may already have done the work.
import { randomUUID } from "node:crypto";
import { utilityProcess, type UtilityProcess } from "electron";
import type { WorkerReply, WorkerRequest } from "./sdk-protocol.ts";

export type CallSettlement =
  | { kind: "result"; result: Record<string, unknown> }
  | { kind: "error"; error: Record<string, unknown> }
  | { kind: "lost" };

interface Pending {
  onEvent: (event: Record<string, unknown>) => void;
  settle: (settlement: CallSettlement) => void;
}

export class SdkHost {
  #child: UtilityProcess | null = null;
  #ready: Promise<void> | null = null;
  readonly #pending = new Map<string, Pending>();

  readonly #entry: string;
  readonly #onExit: (code: number) => void;

  constructor(entry: string, onExit: (code: number) => void) {
    this.#entry = entry;
    this.#onExit = onExit;
  }

  #start(): Promise<void> {
    if (this.#ready) return this.#ready;
    const child = utilityProcess.fork(this.#entry, [], { serviceName: "GptImg SDK", stdio: "inherit" });
    this.#child = child;
    this.#ready = new Promise((resolve) => {
      child.on("message", (reply: WorkerReply) => {
        if (reply.type === "ready") {
          resolve();
          return;
        }
        const pending = this.#pending.get(reply.id);
        if (!pending) return;
        if (reply.type === "event") pending.onEvent(reply.event);
        else {
          this.#pending.delete(reply.id);
          pending.settle(reply.type === "result" ? { kind: "result", result: reply.result } : { kind: "error", error: reply.error });
        }
      });
      child.once("exit", (code) => {
        this.#child = null;
        this.#ready = null;
        resolve();
        for (const [id, pending] of this.#pending) {
          this.#pending.delete(id);
          pending.settle({ kind: "lost" });
        }
        this.#onExit(code);
      });
    });
    return this.#ready;
  }

  /** Runs one chat call; `cancel` is returned at once so the caller can abort while it runs. */
  chat(
    apiKey: string,
    app: { name: string; version: string },
    args: Record<string, unknown>,
    onEvent: (event: Record<string, unknown>) => void,
  ): { id: string; done: Promise<CallSettlement>; cancel: () => void } {
    const id = randomUUID();
    let cancelled = false;
    const done = new Promise<CallSettlement>((settle) => {
      this.#pending.set(id, { onEvent, settle });
      void this.#start().then(() => {
        if (!this.#pending.has(id)) return;
        if (!this.#child) {
          this.#pending.delete(id);
          settle({ kind: "lost" });
          return;
        }
        this.#post({ type: "chat", id, apiKey, app, args });
        if (cancelled) this.#post({ type: "cancel", id });
      });
    });
    return {
      id,
      done,
      cancel: () => {
        cancelled = true;
        this.#post({ type: "cancel", id });
      },
    };
  }

  #post(request: WorkerRequest): void {
    this.#child?.postMessage(request);
  }

  stop(): void {
    this.#child?.kill();
  }
}
