// The messages between main and the SDK's utility process.

export type WorkerRequest =
  | { type: "chat"; id: string; apiKey: string; app: { name: string; version: string }; args: Record<string, unknown> }
  | { type: "cancel"; id: string };

export type WorkerReply =
  | { type: "ready" }
  | { type: "event"; id: string; event: Record<string, unknown> }
  | { type: "result"; id: string; result: Record<string, unknown> }
  | { type: "error"; id: string; error: Record<string, unknown> };
