// The SDK runs in the main process. Its image work runs on libvips's and ONNX
// Runtime's own threads and its network calls are asynchronous, so the window
// stays responsive; a native crash ends the app, as any crash does, and the
// turn's saved message and recorded call are its evidence.
import { GptImg, GptImgError, type GptImgErrorData } from "gptimgsdk";

/** One GptImg for chat turns per key and endpoint (OpenAI's own when null), made again when either changes. */
export function chatClients(app: { name: string; version: string }): (apiKey: string, baseURL: string | null) => GptImg {
  let client: { key: string; baseURL: string | null; sdk: GptImg } | null = null;
  return (apiKey, baseURL) => {
    if (!client || client.key !== apiKey || client.baseURL !== baseURL) {
      client = { key: apiKey, baseURL, sdk: new GptImg({ apiKey, ...(baseURL && { baseURL }), app }) };
    }
    return client.sdk;
  };
}

/** A thrown failure as the SDK's error data: a GptImgError's own form, anything else as internal.unexpected. */
export function errorData(error: unknown): GptImgErrorData {
  if (error instanceof GptImgError) return error.toJSON();
  return {
    name: "GptImgError",
    code: "internal.unexpected",
    kind: "internal",
    effect: "unknown",
    message: error instanceof Error ? error.message : String(error),
  };
}
