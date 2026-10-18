import type { SdkContext } from "../context.ts";
import type { SidecarWriter } from "../types.ts";
import { VERSION } from "../version.ts";

/** The `writer` a format-2 sidecar records: this SDK, and the calling app when the caller named one. */
export function sidecarWriter(ctx: Pick<SdkContext, "app">): SidecarWriter {
  return { name: "gptimgsdk", version: VERSION, ...(ctx.app !== undefined && { app: ctx.app }) };
}
