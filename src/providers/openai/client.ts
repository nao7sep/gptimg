import OpenAI from "openai";
import { nullBase64InResponse } from "../../sidecar/nullBase64.js";
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

/**
 * The headers the client sends from the profile: the key as its bearer token, and the
 * organization and project when the profile sets them. Each attempt's log line records them
 * (data-lifecycle-conventions, *Nothing is cut*).
 */
export function profileHeaders(profile: ResolvedProfile): Record<string, string> {
  const { organization, project } = profile.redacted;
  return {
    Authorization: `Bearer ${profile.apiKey}`,
    ...(organization && { "OpenAI-Organization": organization }),
    ...(project && { "OpenAI-Project": project }),
  };
}

/**
 * What a successful attempt's log line records of the SDK's response: its status, headers,
 * request id and body as the provider sent them, with each base64 image nulled, since the
 * record never holds image bytes (data-lifecycle-conventions, *Records*).
 */
export function recordedResponse(result: { data: unknown; response: Response; request_id: string | null }): Record<string, unknown> {
  return {
    status: result.response.status,
    headers: Object.fromEntries(result.response.headers),
    requestId: result.request_id,
    body: nullBase64InResponse(result.data),
  };
}

export function resolveModel(paramModel: unknown, fallback: string): string {
  if (typeof paramModel === "string" && paramModel.length > 0) return paramModel;
  return fallback;
}
