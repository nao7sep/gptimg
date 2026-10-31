import type { SdkContext } from "../context.ts";
import type { SidecarWriter } from "../types.ts";
import { VERSION } from "../version.ts";

/** The `writer` a sidecar records: this SDK, and the calling program when the caller named one. */
export function sidecarWriter(ctx: Pick<SdkContext, "caller">): SidecarWriter {
  return { name: "gptimgsdk", version: VERSION, ...(ctx.caller !== undefined && { caller: ctx.caller }) };
}
