import type { VisionDetail } from "../types.js";

export const VISION_DEFAULTS: { readonly shrink: { width: number; height: number }; readonly detail: VisionDetail } = {
  shrink: { width: 1024, height: 1024 },
  // OpenAI's literal `auto`, sent as chosen when the recipe sets no detail.
  detail: "auto",
};
