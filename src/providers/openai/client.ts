import OpenAI from "openai";
import type { ResolvedProfile } from "../../types.js";

// Retry policy is owned by callWithRetry; maxRetries=0 disables the SDK's
// built-in retries. Per-request `{ timeout }` is passed at the call site,
// driven by the network category budgets in src/network/defaults.ts.
const CLIENT_PASSTHROUGH_KEYS = new Set(["organization", "project"]);

export function buildOpenAIClient(profile: ResolvedProfile): OpenAI {
  const opts: Record<string, unknown> = {
    apiKey: profile.apiKey,
    maxRetries: 0,
  };
  for (const k of CLIENT_PASSTHROUGH_KEYS) {
    if (k in profile.redacted) {
      opts[k] = profile.redacted[k as keyof typeof profile.redacted];
    }
  }
  return new OpenAI(opts as ConstructorParameters<typeof OpenAI>[0]);
}

export function resolveModel(paramModel: unknown, fallback: string): string {
  if (typeof paramModel === "string" && paramModel.length > 0) return paramModel;
  return fallback;
}
