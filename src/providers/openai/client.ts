import OpenAI from "openai";
import type { ResolvedProfile } from "../../types.js";

const CLIENT_PASSTHROUGH_KEYS = new Set([
  "organization",
  "project",
  "defaultHeaders",
  "defaultQuery",
  "timeout",
  "maxRetries",
  "httpAgent",
]);

export function buildOpenAIClient(profile: ResolvedProfile): OpenAI {
  const opts: Record<string, unknown> = {
    apiKey: profile.apiKey,
  };
  const baseURL = profile.redacted.baseURL;
  if (typeof baseURL === "string" && baseURL.length > 0) {
    opts.baseURL = baseURL;
  }
  for (const k of CLIENT_PASSTHROUGH_KEYS) {
    if (k in profile.redacted) {
      opts[k] = (profile.redacted as Record<string, unknown>)[k];
    }
  }
  return new OpenAI(opts as ConstructorParameters<typeof OpenAI>[0]);
}

export function resolveModel(
  paramModel: unknown,
  profileModel: unknown,
  fallback: string,
): string {
  if (typeof paramModel === "string" && paramModel.length > 0) return paramModel;
  if (typeof profileModel === "string" && profileModel.length > 0) return profileModel;
  return fallback;
}
