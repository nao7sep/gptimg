// The utility process the SDK runs in: one GptImg per key, one call per id,
// every event, progress report and result posted back as plain data. A crash
// here, native image or inference code included, costs the running call,
// never the window.
import { errorData, OPS, sdkCache } from "./sdk-ops.ts";
import type { WorkerReply, WorkerRequest } from "./sdk-protocol.ts";
import type { GptImg } from "gptimgsdk";

const port = process.parentPort;
const running = new Map<string, AbortController>();
const clients = new Map<string, (apiKey: string | null, baseURL: string | null) => GptImg>();

function post(reply: WorkerReply): void {
  port.postMessage(reply);
}

async function call(request: Extract<WorkerRequest, { type: "call" }>): Promise<void> {
  const controller = new AbortController();
  running.set(request.id, controller);
  try {
    const appKey = `${request.app.name}@${request.app.version}`;
    if (!clients.has(appKey)) clients.set(appKey, sdkCache(request.app));
    const sdk = clients.get(appKey)!(request.apiKey, request.baseURL);
    const result = await OPS[request.op](sdk, request.args as never, {
      signal: controller.signal,
      onEvent: (event) => post({ type: "event", id: request.id, event: event as Record<string, unknown> }),
      onProgress: (progress) => post({ type: "progress", id: request.id, progress: progress as Record<string, unknown> }),
      onPartialImage: (partial) => post({ type: "partial", id: request.id, partial }),
    });
    post({ type: "result", id: request.id, result: result as Record<string, unknown> });
  } catch (error) {
    post({ type: "error", id: request.id, error: errorData(error) });
  } finally {
    running.delete(request.id);
  }
}

port.on("message", (event: { data: WorkerRequest }) => {
  const request = event.data;
  if (request.type === "call") void call(request);
  else if (request.type === "cancel") running.get(request.id)?.abort();
});

post({ type: "ready" });
