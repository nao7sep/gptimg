// The SDK host without Electron: runs each operation with the real SDK in the
// test's own process, through the same op table the utility process uses.
import type { CallHooks, CallSettlement, SdkHost } from "../../src/main/sdk-host.ts";
import { errorData, OPS, sdkCache } from "../../src/main/sdk-ops.ts";
import type { SdkOp } from "../../src/main/sdk-protocol.ts";

export function inProcessHost(): SdkHost {
  const sdks = sdkCache({ name: "GptImg", version: "test" });
  const call = (op: SdkOp, _app: unknown, args: Record<string, unknown>, hooks: CallHooks = {}) => {
    const controller = new AbortController();
    const done = (async (): Promise<CallSettlement> => {
      try {
        const result = await OPS[op](sdks(hooks.apiKey ?? null, hooks.baseURL ?? null), args as never, {
          signal: controller.signal,
          onEvent: (event) => hooks.onEvent?.(event as Record<string, unknown>),
          onProgress: (progress) => hooks.onProgress?.(progress as Record<string, unknown>),
        });
        return { kind: "result", result: result as Record<string, unknown> };
      } catch (error) {
        return { kind: "error", error: errorData(error) };
      }
    })();
    return { id: "in-process", done, cancel: () => controller.abort() };
  };
  return {
    call,
    chat: (apiKey: string, baseURL: string | null, app: unknown, args: Record<string, unknown>, onEvent: (e: Record<string, unknown>) => void) =>
      call("chat", app, args, { apiKey, baseURL, onEvent }),
    stop() {},
  } as unknown as SdkHost;
}
