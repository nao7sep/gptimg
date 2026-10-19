import { openaiProvider } from "./openai/index.ts";
import type { Provider } from "./types.ts";

/** The image provider paid verbs call; OpenAI is the only one, and tests substitute it here. */
export function getProvider(): Provider {
  return openaiProvider;
}

export type { Provider } from "./types.ts";
