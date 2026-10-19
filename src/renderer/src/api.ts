// The bridge preload exposes; the renderer's only way to reach main. Read on
// each use rather than once, so nothing holds a stale copy.
import type { GptImgApi } from "../../shared/api.ts";

declare global {
  interface Window {
    gptimg: GptImgApi;
  }
}

export const api: GptImgApi = new Proxy({} as GptImgApi, {
  get: (_target, name) => window.gptimg[name as keyof GptImgApi],
});
