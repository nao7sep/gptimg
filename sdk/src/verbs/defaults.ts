import type { VisionDetail } from "../types.ts";

export const VISION_DEFAULTS: { readonly shrink: { width: number; height: number }; readonly detail: VisionDetail } = {
  shrink: { width: 1024, height: 1024 },
  // OpenAI's literal `auto`, sent as chosen when the policy sets no detail.
  detail: "auto",
};
