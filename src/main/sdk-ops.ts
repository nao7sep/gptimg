// What each SDK operation runs, shared by the utility process and by tests
// that run the SDK in their own process.
import { GptImg } from "gptimgsdk";
import type { SdkOp } from "./sdk-protocol.ts";

export type OpOptions = { signal: AbortSignal; onEvent: (event: unknown) => void; onProgress: (progress: unknown) => void };

export const OPS: Record<SdkOp, (sdk: GptImg, args: never, options: OpOptions) => Promise<unknown> | unknown> = {
  chat: (sdk, args, o) => sdk.chat(args, o),
  inspect: (sdk, args, o) => sdk.inspect(args, o),
  encode: (sdk, args, o) => sdk.encode(args, o),
  resize: (sdk, args, o) => sdk.resize(args, o),
  upscale: (sdk, args, o) => sdk.upscale(args, o),
  modelList: (sdk, _args, o) => sdk.model.list({}, o),
  modelInstall: (sdk, args: { key: "swin2sr" | "birefnet" }, o) => sdk.model.install({ key: args.key }, o),
  modelRelease: (sdk) => sdk.model.release(),
};

/** One GptImg per key and endpoint, made again when either changes. */
export function sdkCache(app: { name: string; version: string }) {
  let client: { key: string | null; baseURL: string | null; sdk: GptImg } | null = null;
  return (apiKey: string | null, baseURL: string | null): GptImg => {
    if (!client || client.key !== apiKey || client.baseURL !== baseURL) {
      client = { key: apiKey, baseURL, sdk: new GptImg({ ...(apiKey && { apiKey }), ...(baseURL && { baseURL }), app }) };
    }
    return client.sdk;
  };
}

/** A thrown failure as plain data: a GptImgError's own form, anything else as internal.unexpected. */
export function errorData(error: unknown): Record<string, unknown> {
  if (error && typeof error === "object" && "toJSON" in error && (error as { name?: string }).name === "GptImgError") {
    return (error as { toJSON(): Record<string, unknown> }).toJSON();
  }
  return {
    name: "GptImgError",
    code: "internal.unexpected",
    kind: "internal",
    effect: "unknown",
    message: error instanceof Error ? error.message : String(error),
  };
}
