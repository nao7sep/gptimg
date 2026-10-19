// The messages between main and the SDK's utility process.

/** The SDK operations the app runs: one turn of a chat, and the local image work an export needs. */
export const SDK_OPS = ["chat", "inspect", "encode", "resize", "upscale", "modelList", "modelInstall", "modelRelease"] as const;
export type SdkOp = (typeof SDK_OPS)[number];

export type WorkerRequest =
  | { type: "call"; id: string; op: SdkOp; apiKey: string | null; baseURL: string | null; app: { name: string; version: string }; args: Record<string, unknown> }
  | { type: "cancel"; id: string };

export type WorkerReply =
  | { type: "ready" }
  | { type: "event"; id: string; event: Record<string, unknown> }
  | { type: "progress"; id: string; progress: Record<string, unknown> }
  | { type: "partial"; id: string; partial: PartialDraft }
  | { type: "result"; id: string; result: Record<string, unknown> }
  | { type: "error"; id: string; error: Record<string, unknown> };

/** A draft of an image while it is drawn (the SDK's PartialImage). */
export interface PartialDraft {
  image: number;
  index: number;
  data: Uint8Array;
  format: string;
}
