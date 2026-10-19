import OpenAI from "openai";
import { nullBase64InResponse } from "../../sidecar/nullBase64.ts";
import type { Credentials } from "../../types.ts";

// Retry policy is owned by callWithRetry; maxRetries=0 disables the SDK's
// built-in retries. Per-request `{ timeout }` is passed at the call site,
// driven by the network category budgets in src/network/defaults.ts.

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * The OpenAI client with every option it would otherwise fill from the process
 * environment set explicitly (sdk-conventions: the SDK reads nothing ambient):
 * the base URL, organization, project, admin key and webhook secret. The one
 * read the client offers no switch for is `OPENAI_CUSTOM_HEADERS`, which it
 * skips only with its `provider` or X.509 `credential` options, neither of
 * which applies here; that residual read is accepted, and a test pins that
 * every other ambient value is ignored.
 */
export function buildOpenAIClient(credentials: Credentials): OpenAI {
  const opts: Record<string, unknown> = {
    apiKey: credentials.apiKey,
    baseURL: DEFAULT_BASE_URL,
    organization: null,
    project: null,
    adminAPIKey: null,
    webhookSecret: null,
    maxRetries: 0,
    // An SDK prints nothing (sdk-conventions); gptimgsdk's own records carry
    // what the client would warn about.
    logLevel: "off",
  };
  if (credentials.organization !== undefined) opts.organization = credentials.organization;
  if (credentials.project !== undefined) opts.project = credentials.project;
  return new OpenAI(opts as ConstructorParameters<typeof OpenAI>[0]);
}

/**
 * The headers that identify the caller, as the built client sends them: its key as the bearer
 * token, and the organization and project the caller gave, if any. Each attempt's event records them,
 * the key masked by the call's logger (data-lifecycle-conventions).
 */
export function clientHeaders(client: OpenAI): Record<string, string> {
  return {
    Authorization: `Bearer ${client.apiKey}`,
    ...(client.organization && { "OpenAI-Organization": client.organization }),
    ...(client.project && { "OpenAI-Project": client.project }),
  };
}

/**
 * What a successful attempt's event records of the SDK's response: its status, headers,
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
