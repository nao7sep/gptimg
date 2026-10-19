// The utility process the SDK runs in: one GptImg per key, one call per id,
// every event and the result posted back as plain data. A crash here costs
// the running turn, never the window.
import { GptImg, type ChatArgs } from "gptimgsdk";
import type { WorkerReply, WorkerRequest } from "./sdk-protocol.ts";

const port = process.parentPort;
const running = new Map<string, AbortController>();
let client: { key: string; sdk: GptImg } | null = null;

function sdkFor(apiKey: string, app: { name: string; version: string }): GptImg {
  if (client?.key !== apiKey) client = { key: apiKey, sdk: new GptImg({ apiKey, app }) };
  return client.sdk;
}

function post(reply: WorkerReply): void {
  port.postMessage(reply);
}

function errorData(error: unknown) {
  if (error && typeof error === "object" && "toJSON" in error && (error as { name?: string }).name === "GptImgError") {
    return (error as { toJSON(): unknown }).toJSON();
  }
  return {
    name: "GptImgError",
    code: "internal.unexpected",
    kind: "internal",
    effect: "unknown",
    message: error instanceof Error ? error.message : String(error),
  };
}

async function chat(request: Extract<WorkerRequest, { type: "chat" }>): Promise<void> {
  const controller = new AbortController();
  running.set(request.id, controller);
  try {
    const result = await sdkFor(request.apiKey, request.app).chat(request.args as unknown as ChatArgs, {
      signal: controller.signal,
      onEvent: (event) => post({ type: "event", id: request.id, event: event as unknown as Record<string, unknown> }),
    });
    post({ type: "result", id: request.id, result: result as unknown as Record<string, unknown> });
  } catch (error) {
    post({ type: "error", id: request.id, error: errorData(error) as Record<string, unknown> });
  } finally {
    running.delete(request.id);
  }
}

port.on("message", (event: { data: WorkerRequest }) => {
  const request = event.data;
  if (request.type === "chat") void chat(request);
  else if (request.type === "cancel") running.get(request.id)?.abort();
});

post({ type: "ready" });
