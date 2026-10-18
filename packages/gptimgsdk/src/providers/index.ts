import { ProviderError } from "../errors.ts";
import { openaiProvider } from "./openai/index.ts";
import type { Provider } from "./types.ts";

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

export type { Provider } from "./types.ts";
