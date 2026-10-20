// The SDK host through the real utility-process module: src/main/sdk-worker.ts
// runs in the test's process behind a stand-in for Electron's parentPort, so
// every request and reply crosses the same code the packaged app runs, the
// options the worker hands each op included.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { CallHooks, CallSettlement, SdkHost } from "../../src/main/sdk-host.ts";
import type { SdkOp, WorkerReply, WorkerRequest } from "../../src/main/sdk-protocol.ts";

export async function workerHost(): Promise<SdkHost> {
  const port = new EventEmitter() as EventEmitter & { postMessage(reply: WorkerReply): void };
  const pending = new Map<string, { hooks: CallHooks; settle: (s: CallSettlement) => void }>();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => (ready = resolve));
  port.postMessage = (reply) => {
    if (reply.type === "ready") return ready();
    const call = pending.get(reply.id);
    if (!call) return;
    if (reply.type === "event") call.hooks.onEvent?.(reply.event);
    else if (reply.type === "progress") call.hooks.onProgress?.(reply.progress);
    else if (reply.type === "partial") call.hooks.onPartial?.(reply.partial);
    else {
      pending.delete(reply.id);
      call.settle(reply.type === "result" ? { kind: "result", result: reply.result } : { kind: "error", error: reply.error });
    }
  };
  const send = (request: WorkerRequest) => port.emit("message", { data: request });
  (process as unknown as { parentPort: unknown }).parentPort = port;
  await import("../../src/main/sdk-worker.ts");
  await started;

  const call = (op: SdkOp, app: { name: string; version: string }, args: Record<string, unknown>, hooks: CallHooks = {}) => {
    const id = randomUUID();
    const done = new Promise<CallSettlement>((settle) => {
      pending.set(id, { hooks, settle });
      send({ type: "call", id, op, apiKey: hooks.apiKey ?? null, baseURL: hooks.baseURL ?? null, app, args });
    });
    return { id, done, cancel: () => send({ type: "cancel", id }) };
  };
  return { call, stop() {} } as unknown as SdkHost;
}
