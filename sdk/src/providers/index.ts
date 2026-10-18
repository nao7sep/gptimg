import { GptImgError } from "../errors.ts";
import { openaiProvider } from "./openai/index.ts";
import type { Provider } from "./types.ts";

export function getProvider(name: string): Provider {
  switch (name) {
    case "openai":
      return openaiProvider;
    default:
      throw new GptImgError("profile.malformed", `Unknown provider: ${name}. gptimgsdk supports: openai`, {
        details: { field: "provider" },
      });
  }
}

export type { Provider } from "./types.ts";
