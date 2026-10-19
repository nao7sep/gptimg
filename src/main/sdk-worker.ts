// The utility process the SDK runs in: one GptImg per key, one call per id,
// every event, progress report and result posted back as plain data. A crash
// here, native image or inference code included, costs the running call,
// never the window.
import { GptImg } from "gptimgsdk";
import type { SdkOp, WorkerReply, WorkerRequest } from "./sdk-protocol.ts";

const port = process.parentPort;
const running = new Map<string, AbortController>();
let client: { key: string | null; baseURL: string | null; sdk: GptImg } | null = null;

function sdkFor(apiKey: string | null, baseURL: string | null, app: { name: string; version: string }): GptImg {
  if (!client || client.key !== apiKey || client.baseURL !== baseURL) {
    client = { key: apiKey, baseURL, sdk: new GptImg({ ...(apiKey && { apiKey }), ...(baseURL && { baseURL }), app }) };
  }
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

type Options = { signal: AbortSignal; onEvent: (event: unknown) => void; onProgress: (progress: unknown) => void };

/** Each op, as the SDK names it; the args arrive already shaped by main. */
const OPS: Record<SdkOp, (sdk: GptImg, args: never, options: Options) => Promise<unknown> | unknown> = {
  chat: (sdk, args, o) => sdk.chat(args, o),
  inspect: (sdk, args, o) => sdk.inspect(args, o),
  encode: (sdk, args, o) => sdk.encode(args, o),
  resize: (sdk, args, o) => sdk.resize(args, o),
  upscale: (sdk, args, o) => sdk.upscale(args, o),
  modelList: (sdk) => sdk.model.list(),
  modelInstall: (sdk, args: { key: "swin2sr" | "birefnet" }, o) => sdk.model.install(args.key, o),
};

async function call(request: Extract<WorkerRequest, { type: "call" }>): Promise<void> {
  const controller = new AbortController();
  running.set(request.id, controller);
  try {
    const result = await OPS[request.op](sdkFor(request.apiKey, request.baseURL, request.app), request.args as never, {
      signal: controller.signal,
      onEvent: (event) => post({ type: "event", id: request.id, event: event as Record<string, unknown> }),
      onProgress: (progress) => post({ type: "progress", id: request.id, progress: progress as Record<string, unknown> }),
    });
    post({ type: "result", id: request.id, result: result as Record<string, unknown> });
  } catch (error) {
    post({ type: "error", id: request.id, error: errorData(error) as Record<string, unknown> });
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
