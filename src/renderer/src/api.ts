// The bridge preload exposes; the renderer's only way to reach main.
import type { GptImgApi } from "../../shared/api.ts";

declare global {
  interface Window {
    gptimg: GptImgApi;
  }
}

export const api: GptImgApi = window.gptimg;
