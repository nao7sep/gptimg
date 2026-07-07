import { ProviderError } from "../errors.js";
import { openaiProvider } from "./openai/index.js";
import type { Provider } from "./types.js";

export function getProvider(name: string): Provider {
  switch (name) {
    case "openai":
      return openaiProvider;
    default:
      throw new ProviderError(
        "provider.unknown",
        `Unknown provider: ${name}. v1 supports: openai`,
      );
  }
}

export type { Provider } from "./types.js";
